import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import { withTimeout } from './protocol';
import { safeAudioError } from './intercom';

export const OSD_WIDTH = 640;
export const OSD_HEIGHT = 480;
export const OSD_FPS = 10;
export const FRAME_BYTES = OSD_WIDTH * OSD_HEIGHT * 3;
export const SCALE_FILTER = `scale=${OSD_WIDTH}:${OSD_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OSD_WIDTH}:${OSD_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

/** Fixed allocation bounds, even when a pipe chunk contains partial/multiple frames. */
export class RawFrames {
    private frame = Buffer.allocUnsafe(FRAME_BYTES);
    private offset = 0;
    push(chunk: Buffer, receive: (frame: Buffer) => void) {
        let position = 0;
        while (position < chunk.length) {
            const count = Math.min(FRAME_BYTES - this.offset, chunk.length - position);
            chunk.copy(this.frame, this.offset, position, position + count);
            this.offset += count; position += count;
            if (this.offset === FRAME_BYTES) {
                receive(this.frame);
                this.frame = Buffer.allocUnsafe(FRAME_BYTES); this.offset = 0;
            }
        }
    }
}

export function stopProcess(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    force.unref(); child.once('close', () => clearTimeout(force));
}

async function imageProcess(ffmpeg: string, args: string[], input: Buffer, limit: number) {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '1', ...args]);
    const chunks: Buffer[] = [];
    let size = 0, error = '';
    child.stdout.on('data', (data: Buffer) => {
        size += data.length;
        if (size <= limit) chunks.push(data); else stopProcess(child);
    });
    child.stderr.on('data', data => { error = (error + data.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    const completed = once(child, 'close');
    child.stdin.end(input);
    try {
        const [code] = await withTimeout(completed, 5000, 'OSD image processing timed out');
        if (code !== 0 || !size || size > limit) throw new Error(safeAudioError(error) || 'OSD image processing failed');
        return Buffer.concat(chunks);
    } finally { stopProcess(child); }
}

export async function decodePoster(ffmpeg: string, jpeg: Buffer) {
    const frame = await imageProcess(ffmpeg, ['-f', 'image2pipe', '-i', 'pipe:0', '-an', '-vf', SCALE_FILTER,
        '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], jpeg, FRAME_BYTES);
    if (frame.length !== FRAME_BYTES) throw new Error('Invalid OSD snapshot dimensions');
    return frame;
}

export function encodePoster(ffmpeg: string, rgb: Buffer) {
    return imageProcess(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${OSD_WIDTH}x${OSD_HEIGHT}`,
        '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'], rgb, 1024 * 1024);
}
