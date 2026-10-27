import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { NO_SNAPSHOT_JPEG } from './no-snapshot';

const MAX_JPEG_BYTES = 1024 * 1024;
const PERSIST_INTERVAL_MS = 30000;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Bounded framing for FFmpeg's MJPEG image2pipe output. */
export class JpegFrames {
    private pending = Buffer.alloc(0);
    push(chunk: Buffer): Buffer[] {
        this.pending = Buffer.concat([this.pending, chunk]);
        const frames: Buffer[] = [];
        while (this.pending.length) {
            const start = this.pending.indexOf(SOI);
            if (start < 0) { this.pending = this.pending.subarray(-1); break; }
            if (start) this.pending = this.pending.subarray(start);
            const end = this.pending.indexOf(EOI, 2);
            if (end < 0) {
                if (this.pending.length > MAX_JPEG_BYTES) this.pending = Buffer.alloc(0);
                break;
            }
            if (end + 2 <= MAX_JPEG_BYTES) frames.push(Buffer.from(this.pending.subarray(0, end + 2)));
            this.pending = this.pending.subarray(end + 2);
        }
        return frames;
    }
}

interface SnapshotSession extends EventEmitter { closed: boolean; }
interface ActiveDecoder {
    source: SnapshotSession;
    child: ChildProcessWithoutNullStreams;
    onClose: () => void;
}

/** Snapshot reads are strictly local. Only an already-open media session may feed this cache. */
export class SnapshotCache extends EventEmitter {
    private image?: Buffer;
    capturedAt?: number;
    private lastSavedAt = 0;
    private active?: ActiveDecoder;
    constructor(private unit: string, load: () => string | null | undefined,
        private persist: (value: string) => void, private log: (message: string) => void = () => {}) {
        super();
        try {
            const value = JSON.parse(load() || 'null');
            if (value?.unit !== unit || typeof value.jpeg !== 'string' || value.jpeg.length > MAX_JPEG_BYTES * 1.4
                || !Number.isFinite(value.capturedAt) || value.capturedAt <= 0) return;
            const image = Buffer.from(value.jpeg, 'base64');
            if (image.length >= 4 && image.length <= MAX_JPEG_BYTES && image.subarray(0, 2).equals(SOI) && image.subarray(-2).equals(EOI)) {
                this.image = image; this.capturedAt = value.capturedAt;
            }
        } catch { /* A missing or corrupt cache must never trigger a camera connection. */ }
    }
    read(): Buffer { return Buffer.from(this.image || NO_SNAPSHOT_JPEG); }
    private accept(image: Buffer) {
        this.image = image;
        this.capturedAt = Date.now();
        if (this.capturedAt - this.lastSavedAt >= PERSIST_INTERVAL_MS) this.save();
        this.emit('updated', this.capturedAt);
    }
    private save() {
        if (!this.image || !this.capturedAt) return;
        try {
            this.persist(JSON.stringify({ unit: this.unit, capturedAt: this.capturedAt, jpeg: this.image.toString('base64') }));
            this.lastSavedAt = Date.now();
        } catch { this.log('Could not persist the last snapshot; the memory cache is still available'); }
    }
    start(source: SnapshotSession, ffmpeg: string, passiveUrl: string) {
        if (source.closed || this.active?.source === source) return;
        this.stop();
        // This URL can only attach to an existing session. It cannot start a monitor,
        // increment the viewer count, or prevent the normal idle timeout.
        const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
            '-analyzeduration', '500000', '-probesize', '500000', '-i', passiveUrl,
            '-an', '-vf', 'fps=1,scale=640:-2:force_original_aspect_ratio=decrease',
            '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1']);
        const decoder: ActiveDecoder = { source, child, onClose: () => { if (this.active === decoder) this.stop(); } };
        this.active = decoder;
        source.once('close', decoder.onClose);
        const frames = new JpegFrames();
        child.stdout.on('data', (chunk: Buffer) => {
            if (this.active !== decoder) return;
            for (const frame of frames.push(chunk)) this.accept(frame);
        });
        child.stdin.end();
        child.stderr.resume();
        const ended = () => {
            source.off('close', decoder.onClose);
            if (this.active === decoder) { this.active = undefined; this.save(); }
        };
        child.once('error', () => { this.log('Snapshot decoder unavailable; keeping the last cached image'); ended(); });
        child.once('close', ended);
    }
    stop() {
        const decoder = this.active;
        this.active = undefined;
        if (decoder) {
            decoder.source.off('close', decoder.onClose);
            decoder.child.kill();
        }
        this.save();
    }
}
