import net, { Socket } from 'net';
import { randomBytes } from 'crypto';
import { StreamTrack } from './media';
import { EventEmitter } from 'events';

export interface RtspMediaSession extends EventEmitter {
    tracks: StreamTrack[];
    closed: boolean;
    audioPacketsForwarded: number;
    addViewer(path?: string): void;
    removeViewer(path?: string): void;
    requestKeyframe(): void;
}

export function rtspSdp(tracks: StreamTrack[]): string {
    const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Aiphone WP-2MED', 'c=IN IP4 127.0.0.1', 't=0 0', 'a=control:*'];
    tracks.forEach((track, index) => {
        lines.push(`m=${track.kind} 0 RTP/AVP ${track.payloadType}`, track.rtpmap);
        if (track.fmtp) lines.push(track.fmtp);
        if (track.framerate) lines.push(`a=framerate:${track.framerate}`);
        lines.push('a=sendonly', `a=control:trackID=${index}`);
    });
    return lines.join('\r\n') + '\r\n';
}

/** Loopback-only RTSP/TCP relay; encrypted WebRTC is terminated by werift. */
export class RtspServer {
    private readonly token = randomBytes(24).toString('hex');
    private readonly server: net.Server;
    private readonly sockets = new Set<Socket>();
    url = '';
    constructor(private getSession: () => Promise<RtspMediaSession>, private log: (message: string) => void,
        private getExistingSession?: () => RtspMediaSession | undefined,
        private onPlay?: (session: RtspMediaSession, path: string, active: () => boolean) => void,
        private onDescribe?: (path: string, active: () => boolean) => void) {
        this.server = net.createServer(socket => this.accept(socket));
    }
    async listen() {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
        });
        const address = this.server.address() as net.AddressInfo;
        this.url = `rtsp://127.0.0.1:${address.port}/${this.token}`;
        return this.url;
    }
    get passiveUrl() { return this.url + '/snapshot-cache'; }
    private accept(socket: Socket) {
        if (this.sockets.size >= 16) { socket.destroy(); return; }
        this.sockets.add(socket);
        socket.setNoDelay(true);
        socket.setTimeout(70000, () => socket.destroy());
        let buffer = Buffer.alloc(0);
        let processing = false;
        let session: RtspMediaSession | undefined;
        let viewerPath = '';
        let playing = false;
        let viewerActive = true;
        let passive = false;
        const channels = new Map<string, number>();
        const sessionId = randomBytes(8).toString('hex');
        const response = (code: number, cseq: string, headers: Record<string, string> = {}, body = '') => {
            const reason: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 454: 'Session Not Found', 461: 'Unsupported Transport', 500: 'Internal Server Error', 503: 'Service Unavailable' };
            socket.write(`RTSP/1.0 ${code} ${reason[code]}\r\nCSeq: ${cseq}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`);
        };
        const forward = (kind: string, data: Buffer, rtcp: boolean) => {
            const channel = channels.get(kind);
            if (!playing || channel === undefined || socket.destroyed) return;
            if (socket.writableLength > 2 * 1024 * 1024 || data.length > 65535) { socket.destroy(); return; }
            if (kind === 'audio' && !rtcp && !passive && session) session.audioPacketsForwarded++;
            const head = Buffer.alloc(4);
            head[0] = 0x24; head[1] = channel + (rtcp ? 1 : 0); head.writeUInt16BE(data.length, 2);
            socket.write(Buffer.concat([head, data]));
        };
        const onRtp = (kind: string, data: Buffer) => forward(kind, data, false);
        const onRtcp = (kind: string, data: Buffer) => forward(kind, data, true);
        const onClose = () => socket.destroy();
        socket.on('close', () => {
            viewerActive = false;
            this.sockets.delete(socket);
            if (session) {
                session.off('rtp', onRtp); session.off('rtcp', onRtcp); session.off('close', onClose);
                if (playing && !passive) session.removeViewer(viewerPath);
            }
        });
        socket.on('error', () => {});
        const processBuffer = async () => {
            if (processing) return;
            processing = true;
            try {
                while (!socket.destroyed && buffer.length) {
                    if (buffer[0] === 0x24) {
                        if (buffer.length < 4) break;
                        const size = 4 + buffer.readUInt16BE(2);
                        if (buffer.length < size) break;
                        // Client receiver reports are optional; upstream PLI is sent periodically.
                        buffer = buffer.subarray(size); continue;
                    }
                    const end = buffer.indexOf('\r\n\r\n');
                    if (end < 0) break;
                    const header = buffer.subarray(0, end).toString();
                    const [first, ...rest] = header.split('\r\n');
                    const [method, uri, version] = first.split(' ');
                    const headers = Object.fromEntries(rest.map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
                    const contentLength = Number(headers['content-length'] || 0);
                    if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > 65536) { socket.destroy(); break; }
                    if (buffer.length < end + 4 + contentLength) break;
                    buffer = buffer.subarray(end + 4 + contentLength);
                    const cseq = headers.cseq || '0';
                    let path: string;
                    try { path = new URL(uri).pathname; } catch { response(400, cseq); continue; }
                    if (version !== 'RTSP/1.0') { response(400, cseq); continue; }
                    if (path !== `/${this.token}` && !path.startsWith(`/${this.token}/`)) { response(404, cseq); continue; }
                    if (headers.session && headers.session.split(';')[0] !== sessionId) { response(454, cseq); continue; }
                    if (method === 'OPTIONS') response(200, cseq, { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN' });
                    else if (method === 'DESCRIBE') {
                        viewerPath = path;
                        passive = path === `/${this.token}/snapshot-cache` || path.startsWith(`/${this.token}/snapshot-cache/`);
                        if (!passive) this.onDescribe?.(viewerPath, () => viewerActive && !socket.destroyed);
                        try {
                            session = passive ? this.getExistingSession?.() : await this.getSession();
                            if (!session || session.closed) throw new Error('No existing video session');
                        }
                        catch (error) {
                            this.log(`RTSP stream: ${(error as Error).message}`);
                            response(503, cseq, { 'Retry-After': '5' });
                            socket.end(); break;
                        }
                        if (socket.destroyed) break;
                        response(200, cseq, { 'Content-Type': 'application/sdp', 'Content-Base': (passive ? this.passiveUrl : this.url) + '/' }, rtspSdp(session.tracks));
                        session.on('close', onClose);
                    } else if (method === 'SETUP') {
                        if (!session || session.closed) { response(454, cseq); continue; }
                        const transport = headers.transport || '';
                        const match = transport.match(/interleaved=(\d+)-(\d+)/i);
                        if (!/RTP\/AVP\/TCP/i.test(transport) || !match || Number(match[1]) > 254 || Number(match[2]) !== Number(match[1]) + 1) { response(461, cseq); continue; }
                        const index = Number(path.match(/\/trackID=(\d+)$/)?.[1]);
                        const track = session.tracks[index];
                        if (!track) { response(404, cseq); continue; }
                        channels.set(track.kind, Number(match[1]));
                        response(200, cseq, { Transport: `RTP/AVP/TCP;unicast;interleaved=${match[1]}-${match[2]}`, Session: `${sessionId};timeout=60` });
                    } else if (method === 'PLAY') {
                        if (!session || session.closed || !channels.size) { response(454, cseq); continue; }
                        response(200, cseq, { Session: sessionId, Range: 'npt=0.000-' });
                        if (!playing) {
                            playing = true;
                            session.on('rtp', onRtp); session.on('rtcp', onRtcp);
                            if (passive) session.requestKeyframe();
                            else {
                                session.addViewer(viewerPath);
                                this.onPlay?.(session, viewerPath, () => playing && viewerActive && !socket.destroyed);
                            }
                        }
                    } else if (method === 'GET_PARAMETER') response(200, cseq, { Session: sessionId });
                    else if (method === 'TEARDOWN') { viewerActive = false; response(200, cseq, { Session: sessionId }); socket.end(); break; }
                    else response(405, cseq);
                }
            } catch (err) { this.log(`RTSP stream: ${(err as Error).message}`); socket.destroy(); }
            finally { processing = false; }
        };
        socket.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
            void processBuffer();
        });
    }
    async close() {
        for (const socket of this.sockets) socket.destroy();
        if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}
