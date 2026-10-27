import type { RequestMediaStreamOptions } from '@scrypted/sdk';
import type { AiphoneSession } from './media';

export const AUTO_ANSWER_OFF = 'Off';
export const AUTO_ANSWER_RINGING = 'While Ringing';
export const AUTO_ANSWER_ALWAYS = 'Always';
export type AutoAnswerMode = 'off' | 'ringing' | 'always';

export function isForegroundStream(options?: RequestMediaStreamOptions) {
    // Rebroadcast passes the advertised stream metadata to its background
    // reader. HomeKit/WebRTC foreground requests carry destination hints.
    const advertised = options && 'source' in options
        && !options.destination && !options.destinationId && !options.destinationType;
    return options?.refresh !== false && !options?.prebuffer && options?.destination !== 'local-recorder'
        && options?.destination !== 'remote-recorder' && !advertised;
}
export function isEarlyHomeKitStream(options?: RequestMediaStreamOptions) {
    return options?.destinationType === '@scrypted/homekit' && isForegroundStream(options);
}

/** HomeKit exposes stream START, not notification taps. Keep an early intent
 * alive briefly until its actual RTSP reader can supply a precise lifetime. */
export class EarlyViewIntent {
    private reader?: () => boolean;
    private cancelled = false;
    private readonly expires: number;
    constructor(private readonly now: () => number = Date.now) { this.expires = now() + 30000; }
    readonly active = () => !this.cancelled && (this.reader ? this.reader() : this.now() < this.expires);
    bind(reader: () => boolean) { this.reader = reader; }
    cancel() { this.cancelled = true; }
}

export interface AutoAnswerHost {
    mode(): AutoAnswerMode;
    online(): boolean;
    ringingId(): string | undefined;
    current(): AiphoneSession | undefined;
    ringingSession(cid: string): Promise<AiphoneSession | undefined>;
    monitor(): Promise<AiphoneSession>;
    log(message: string): void;
}

/** One PLAY event, one target session. Never follows a future call or starts
 * microphone capture. Settings and the viewer are rechecked after setup. */
export async function autoAnswerOnView(host: AutoAnswerHost, active: () => boolean, existing?: AiphoneSession) {
    const mode = host.mode();
    if (mode === 'off' || !active() || !host.online()) return;
    const cid = host.ringingId();
    if (mode === 'ringing' && !cid) return;
    const session = existing || (mode === 'ringing' ? await host.ringingSession(cid!) : await host.monitor());
    if (!session || session.accepted) return;
    const allowed = () => {
        const currentMode = host.mode();
        return currentMode !== 'off' && active() && host.online() && host.current() === session && !session.closed
            && (mode !== 'ringing' || session.kind === 'ring' && session.cid === cid)
            && (currentMode === 'always' || session.kind === 'ring' && host.ringingId() === session.cid);
    };
    if (!allowed()) return;
    host.log(`Experimental auto-answer: live view, ${session.kind === 'ring' ? 'incoming' : 'monitor'} session`);
    await session.answer(allowed);
    host.log(session.accepted && !session.closed ? 'Experimental auto-answer: call accepted; microphone controlled by viewer'
        : 'Experimental auto-answer: cancelled after viewer or settings changed');
}
