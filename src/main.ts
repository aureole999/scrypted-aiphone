import sdk, { ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes,
    DeviceProvider, Settings, Setting, SettingValue, Camera, VideoCamera, Intercom, BinarySensor,
    Online, OnOff, MediaObject, RequestMediaStreamOptions, RequestPictureOptions, FFmpegInput, Readme } from '@scrypted/sdk';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import { randomBytes } from 'crypto';
import { AiphoneController } from './controller';
import { AiphoneSession } from './media';
import { Credentials, credentialsFromJSON, Deferred } from './protocol';
import { pairAiphone, pairingNetworkSummary, probePairingNetwork, PairingOptions } from './pairing';
import { RtspServer } from './rtsp';
import { SnapshotCache } from './snapshot';
import { intercomArguments, safeAudioError } from './intercom';
import { AccessoryOptions, readableReplyFile } from './reply';
import { StatusVideo } from './status-video';
import { DIRECT_MODE, STATUS_MODE } from './osd';
import { OSD_WIDTH, OSD_HEIGHT, OSD_FPS } from './video-frames';
import { AUTO_ANSWER_OFF, AUTO_ANSWER_RINGING, AUTO_ANSWER_ALWAYS, AutoAnswerMode, autoAnswerOnView, EarlyViewIntent, isEarlyHomeKitStream, isForegroundStream } from './auto-answer';

const DOORBELL = 'doorbell';
const UNLOCK = 'unlock';
const REPLY = 'reply';
const RING_SENSOR = 'ring-sensor';
const cameraInterfaces = [ScryptedInterface.Camera, ScryptedInterface.VideoCamera, ScryptedInterface.Intercom,
    ScryptedInterface.BinarySensor, ScryptedInterface.Online, ScryptedInterface.Settings];

export class Doorbell extends ScryptedDeviceBase implements Camera, VideoCamera, Intercom, BinarySensor, Online, Settings {
    readonly controller: AiphoneController;
    private readonly rtsp: RtspServer;
    private readonly listening: Promise<string>;
    private readonly snapshotCache: SnapshotCache;
    private audio?: ChildProcessWithoutNullStreams;
    private audioSession?: AiphoneSession;
    private startingAudio = false;
    private audioGeneration = 0;
    private audioAbort?: AbortController;
    private audioOwner?: 'microphone' | 'reply';
    private audioCompletion?: Deferred<void>;
    private microphoneStart?: Promise<{ done: Promise<void> }>;
    private pausedMicrophone?: {
        child: ChildProcessWithoutNullStreams; session: AiphoneSession; completion: Deferred<void>;
    };
    private replySession?: AiphoneSession;
    private replyRunning = false;
    private replyGeneration = 0;
    private replyStatus = 'Not played';
    private intercomError = '';
    private lastStatus = '';
    private audioWatchdog?: NodeJS.Timeout;
    private settingsRefreshTimers: NodeJS.Timeout[] = [];
    private closing = false;
    private statusVideo?: StatusVideo;
    private earlyViews?: Map<string, EarlyViewIntent>;
    constructor(credentials: Credentials, private readonly accessoryOptions: () => AccessoryOptions = () => ({ unlock: false, reply: false }),
        private readonly experimentalMode: () => boolean = () => false,
        private readonly autoAnswerMode: () => AutoAnswerMode = () => 'off',
        private readonly ringChanged: (ringing: boolean) => void = () => {}) {
        super(DOORBELL);
        this.binaryState = false; this.online = this.isExperimental();
        this.snapshotCache = new SnapshotCache(credentials.unit_mac, () => this.storage.getItem('snapshotCache'),
            value => this.storage.setItem('snapshotCache', value), message => this.console.log(message));
        this.controller = new AiphoneController(credentials, message => this.console.log(message));
        this.controller.on('state', () => {
            this.syncRingState();
            this.online = this.isExperimental() || this.controller.online;
            void this.settingsChanged();
        });
        this.controller.on('ring', () => this.incomingRing());
        this.rtsp = new RtspServer(() => this.controller.ensureVideo(), message => this.console.error(safeAudioError(message)),
            () => this.controller.session, (session, path, active) => {
                if (path.endsWith('/watch') && !this.bindEarlyView(path, active)) void this.foregroundViewStarted(active, session as AiphoneSession);
            }, (path, active) => { this.bindEarlyView(path, active); });
        this.listening = this.rtsp.listen();
        void this.listening.catch(err => this.console.error(err));
        this.controller.on('video', (session: AiphoneSession) => {
            this.console.log(`Video ready: ${session.kind}`);
            const diagnostics = setInterval(() => this.logAudioStats(session), 15000);
            const removeStatusListener = this.bindSessionStatus(session);
            session.once('close', () => {
                clearInterval(diagnostics);
                removeStatusListener();
                this.logAudioStats(session);
                if (this.snapshotCache.capturedAt)
                    this.console.log(`Snapshot captured: ${new Date(this.snapshotCache.capturedAt).toLocaleString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false })} JST`);
                void this.settingsChanged().catch(() => {});
            });
            void this.settingsChanged().catch(() => {});
            void Promise.all([this.listening, sdk.mediaManager.getFFmpegPath()]).then(([, ffmpeg]) => {
                if (this.controller.session === session && !session.closed)
                    this.snapshotCache.start(session, ffmpeg, this.rtsp.passiveUrl);
            }).catch(() => this.console.warn('Snapshot decoder unavailable; cached snapshots remain available'));
        });
        this.controller.start();
    }
    private incomingRing() {
        if (this.closing) return;
        this.setRingState(false);
        this.setRingState(true);
    }
    private syncRingState() {
        const ringing = !this.closing && this.controller.online && this.controller.state === 'ringing';
        if (this.binaryState !== ringing) this.setRingState(ringing);
    }
    private setRingState(ringing: boolean) {
        this.binaryState = ringing;
        this.ringChanged(ringing);
    }
    private async settingsChanged() {
        if (this.closing) return;
        const status = this.statusText();
        if (status !== this.lastStatus) { this.lastStatus = status; this.console.log(status); }
        // Retry status snapshots after asynchronous player setup.
        this.settingsRefreshTimers.forEach(clearTimeout);
        this.settingsRefreshTimers = [500, 2000].map(delay => setTimeout(() => {
            void this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => {});
        }, delay));
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
    private statusText() { return `Connection: ${this.controller.online ? 'Connected' : 'Disconnected'}; Doorbell: ${this.doorbellState()}`; }
    private doorbellState() {
        if (!this.controller.online) return 'Offline';
        const session = this.controller.session;
        const microphone = this.audioOwner === 'microphone' && (this.startingAudio
            || !!this.audio && this.audioSession === session && !session?.closed);
        if (microphone && (!session || session.closed || !session.accepted)) return 'Requesting call';
        if (this.replyRunning) return this.replyStatus === 'Playing reply' ? 'Playing reply' : 'Preparing reply';
        if (session?.answering) return 'Requesting call';
        if (this.controller.state === 'ringing' && !session?.accepted) return 'Ringing';
        if (session && !session.closed) {
            if (!session.accepted) return 'Monitoring';
            if (!session.talkAudioReady) return 'Connecting audio';
            return microphone ? 'In call' : 'Answered (mic off)';
        }
        return 'Idle';
    }
    private bindSessionStatus(session: AiphoneSession) {
        const changed = () => {
            if (this.statusText() !== this.lastStatus) void this.settingsChanged().catch(() => {});
        };
        session.on('state', changed);
        return () => session.off('state', changed);
    }
    private logAudioStats(session: AiphoneSession) {
        this.console.log(`Audio statistics: ${JSON.stringify(session.audioDiagnostics)}`);
    }
    private isExperimental() { return this.experimentalMode?.() === true; }
    private foregroundViewStarted(active: () => boolean, session?: AiphoneSession) {
        return autoAnswerOnView({
            mode: () => this.closing ? 'off' : this.autoAnswerMode?.() || 'off',
            online: () => this.controller.online,
            ringingId: () => this.controller.ringingCallId,
            current: () => this.controller.session,
            ringingSession: cid => this.controller.ringingSession(cid),
            monitor: () => this.controller.ensureVideo(),
            log: message => this.console.log(message),
        }, active, session).catch(error => this.console.error(`Experimental auto-answer failed: ${safeAudioError((error as Error).message)}`));
    }
    private beginHomeKitView(options?: RequestMediaStreamOptions) {
        const mode = this.autoAnswerMode?.() || 'off';
        if (!isEarlyHomeKitStream(options) || mode === 'off' || this.closing || !this.controller.online
            || mode === 'ringing' && !this.controller.ringingCallId) return;
        const id = randomBytes(8).toString('hex'), intent = new EarlyViewIntent();
        (this.earlyViews ||= new Map()).set(id, intent);
        this.console.log('Experimental auto-answer: starting on HomeKit live video request');
        void this.foregroundViewStarted(intent.active).finally(() => { this.earlyViews?.delete(id); });
        return { id, intent };
    }
    private bindEarlyView(path: string, active: () => boolean) {
        const id = path.match(/\/intent\/([a-f0-9]{16})\/watch$/)?.[1];
        const intent = id ? this.earlyViews?.get(id) : undefined;
        if (!intent) return false;
        intent.bind(active); return true;
    }
    private getStatusVideo() {
        return this.statusVideo ||= new StatusVideo({
            ffmpeg: () => sdk.mediaManager.getFFmpegPath(),
            snapshot: () => this.snapshotCache.read(),
            state: () => ({ online: this.controller.online, call: this.doorbellState(), capturedAt: this.snapshotCache.capturedAt }),
            source: () => this.controller.session,
            sourceUrl: () => this.rtsp.passiveUrl,
            monitor: () => this.controller.ensureVideo(),
            viewOpened: (active, path) => { this.bindEarlyView(path, active); },
            viewStarted: (active, path) => { if (!this.bindEarlyView(path, active)) void this.foregroundViewStarted(active); },
            log: message => this.console.log(message),
        });
    }
    async getVideoStreamOptions() {
        const experimental = this.isExperimental();
        return [{ id: 'cloud', name: experimental ? 'Aiphone Status + OSD (Experimental)' : 'Aiphone Live Video', container: 'rtsp',
            source: experimental ? 'synthetic' as const : 'cloud' as const,
            video: experimental ? { codec: 'h264', width: OSD_WIDTH, height: OSD_HEIGHT, fps: OSD_FPS } : { codec: 'h264' },
            audio: { codec: 'pcm_mulaw', sampleRate: 8000 }, userConfigurable: false }];
    }
    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const foreground = isForegroundStream(options);
        const early = this.beginHomeKitView(options);
        try {
            if (this.isExperimental()) {
                await this.listening;
                const url = await this.getStatusVideo().getStream(foreground, early?.id);
                return await sdk.mediaManager.createFFmpegMediaObject({ url, container: 'rtsp',
                    inputArguments: ['-rtsp_transport', 'tcp', '-i', url], mediaStreamOptions: (await this.getVideoStreamOptions())[0] });
            }
            if (!this.controller.online) throw new Error('Aiphone MQTT is not connected');
            await this.listening;
            if (options?.refresh === false && (!this.controller.session || this.controller.session.closed))
                throw new Error('No active video session is available for this passive request');
            const url = options?.refresh === false ? this.rtsp.passiveUrl : this.rtsp.url
                + (foreground ? early ? `/intent/${early.id}/watch` : '/watch' : '/background');
            return await sdk.mediaManager.createFFmpegMediaObject({
                url, container: 'rtsp', inputArguments: ['-rtsp_transport', 'tcp', '-i', url],
                mediaStreamOptions: (await this.getVideoStreamOptions())[0],
            });
        } catch (error) { early?.intent.cancel(); throw error; }
    }
    async getPictureOptions() { return []; }
    async takePicture(_options?: RequestPictureOptions): Promise<MediaObject> {
        if (this.isExperimental()) {
            try { return sdk.mediaManager.createMediaObject(await this.getStatusVideo().takePicture(), 'image/jpeg'); }
            catch (error) { this.console.error(`OSD snapshot: ${safeAudioError((error as Error).message)}`); }
        }
        return sdk.mediaManager.createMediaObject(this.snapshotCache.read(), 'image/jpeg');
    }

    async startIntercom(media: MediaObject): Promise<void> {
        if (this.replyRunning || this.startingAudio || this.audio) throw new Error('A microphone or recording is already using the doorbell');
        const starting = this.microphoneStart = this.startAudio(media, 'microphone');
        try { await starting; }
        finally { if (this.microphoneStart === starting) this.microphoneStart = undefined; }
    }
    private async startAudio(media: MediaObject, owner: 'microphone' | 'reply', retainedSession?: AiphoneSession): Promise<{ done: Promise<void> }> {
        if (this.startingAudio || this.audio || (owner === 'microphone' && this.replyRunning)) throw new Error('A microphone or recording is already using the doorbell');
        this.startingAudio = true;
        const abort = this.audioAbort = new AbortController();
        this.audioOwner = owner;
        const completion = this.audioCompletion = new Deferred<void>();
        this.intercomError = '';
        this.setIntercomState(owner === 'reply' ? 'Quick reply requested' : 'Intercom requested by HomeKit/Scrypted');
        void this.settingsChanged().catch(() => {});
        const generation = ++this.audioGeneration;
        const assertCurrent = () => { if (generation !== this.audioGeneration) throw new Error('Intercom was cancelled'); };
        let session: AiphoneSession | undefined = retainedSession;
        try {
            const input = JSON.parse((await sdk.mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput)).toString()) as FFmpegInput;
            if (!Array.isArray(input.inputArguments)) throw new Error('Scrypted did not provide an FFmpeg audio input');
            const ffmpeg = await sdk.mediaManager.getFFmpegPath();
            assertCurrent();
            session ||= await this.controller.ensureVideo();
            assertCurrent();
            this.audioSession = session;
            if (owner === 'reply') this.replySession = session;
            this.setIntercomState('Requesting doorbell call');
            await session.answer();
            assertCurrent();
            if (owner === 'reply') {
                this.setIntercomState('Call accepted; waiting for audio');
                await session.waitForReplyAudio(abort.signal);
                assertCurrent();
            }
            if (session.closed) throw new Error('Doorbell call ended');
            // File decoders deliver bursts; retain them instead of applying the
            // microphone's short queue, which deliberately drops stale live audio.
            if (session.uplink) session.uplink.maxBufferedFrames = owner === 'reply' ? 64 : 8;
            this.setIntercomState(owner === 'reply' ? 'Call accepted; preparing reply audio' : 'Call accepted; waiting for HomeKit microphone audio');
            const child = spawn(ffmpeg, intercomArguments(input.inputArguments),
                { env: { ...process.env, ...input.env } });
            this.audio = child; this.audioSession = session;
            let pending = Buffer.alloc(0);
            let audioBytes = 0;
            let decoderError = '';
            this.audioWatchdog = setTimeout(() => {
                if (this.audio === child && !audioBytes) this.setIntercomState('Call accepted, but no decoded microphone audio received');
            }, 15000);
            child.stdout.on('data', (chunk: Buffer) => {
                // A superseded microphone may keep its input connected until hangup.
                // Never let its late decoded frames mix with a prerecorded reply.
                if (this.audio !== child || session!.closed) return;
                if (!audioBytes) this.setIntercomState(owner === 'reply' ? 'Sending reply audio' : 'Sending microphone audio');
                audioBytes += chunk.length;
                pending = Buffer.concat([pending, chunk]);
                while (pending.length >= 160) { session!.uplink?.push(pending.subarray(0, 160)); pending = pending.subarray(160); }
            });
            child.stderr.on('data', data => { decoderError = (decoderError + data.toString()).slice(-4096); });
            const stopAudio = () => { child.kill(); };
            session.on('close', stopAudio);
            let completed = false;
            const finished = (code?: number | null) => {
                if (completed) return;
                completed = true;
                session!.off('close', stopAudio);
                if (this.audio !== child) {
                    if (this.pausedMicrophone?.child === child) this.pausedMicrophone = undefined;
                    completion.resolve(); return;
                }
                if (owner === 'reply' && pending.length && !session!.closed) {
                    const finalFrame = Buffer.alloc(160, 0xff);
                    pending.copy(finalFrame); session!.uplink?.push(finalFrame);
                }
                if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
                this.logAudioStats(session!);
                let failure: Error | undefined;
                if (typeof code === 'number' && code !== 0 && !session!.closed) {
                    this.intercomError = safeAudioError(decoderError) || this.intercomError || `Audio decoder exited: ${code}`;
                    failure = new Error(this.intercomError);
                    this.setIntercomState('Audio conversion failed');
                    this.console.error(this.intercomError);
                } else this.setIntercomState(session!.closed ? 'Call ended' : owner === 'reply' ? 'Reply sent; call remains active' : 'Intercom audio ended');
                this.audio = undefined; this.audioSession = undefined; this.audioOwner = undefined; this.audioCompletion = undefined;
                // Drain the recording, but keep the accepted call alive for the viewer.
                setTimeout(() => {
                    void (async () => {
                        try { if (owner === 'reply' && !failure) await session!.uplink?.drain(); }
                        catch (error) { failure = error as Error; }
                        finally {
                            if (owner !== 'reply' && !this.audio && !this.startingAudio && !this.replyRunning) await session!.close();
                        }
                        if (failure) completion.reject(failure); else completion.resolve();
                    })().catch(error => completion.reject(error));
                }, 200);
            };
            child.once('close', finished);
            child.once('error', err => {
                if (this.audio !== child) {
                    if (this.pausedMicrophone?.child === child) this.pausedMicrophone = undefined;
                    completion.resolve(); return;
                }
                this.intercomError = safeAudioError(err.message); this.console.error(`Audio decoder: ${this.intercomError}`); finished(-1);
            });
            await once(child, 'spawn');
            return { done: completion.promise };
        } catch (err) {
            completion.reject(err as Error);
            this.intercomError = safeAudioError((err as Error).message);
            if (generation !== this.audioGeneration) this.setIntercomState('Intercom startup cancelled');
            else this.console.error(`Intercom startup failed: ${this.intercomError}`);
            if (session) this.logAudioStats(session);
            if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
            if (this.audioSession === session) { this.audio?.kill(); this.audio = undefined; this.audioSession = undefined; }
            if (this.audioCompletion === completion) { this.audioCompletion = undefined; this.audioOwner = undefined; }
            if (owner !== 'reply') await session?.close();
            throw err;
        } finally {
            if (this.audioAbort === abort) this.audioAbort = undefined;
            this.startingAudio = false;
            void this.settingsChanged().catch(() => {});
        }
    }
    private setIntercomState(state: string) {
        this.console.log(`Intercom: ${state}`);
    }
    async stopIntercom(): Promise<void> {
        // A user who disables the original microphone during a reply must not
        // have it silently restored later. Only stop that suspended input.
        this.discardPausedMicrophone();
        await this.stopAudio('microphone');
    }
    private async stopAudio(owner?: 'microphone' | 'reply', keepCall = false): Promise<void> {
        if (owner && this.audioOwner !== owner) return;
        this.audioGeneration++;
        this.audioAbort?.abort(); this.audioAbort = undefined;
        if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
        if (this.audioSession) this.logAudioStats(this.audioSession);
        this.setIntercomState('Intercom stopped');
        const session = this.audioSession;
        const child = this.audio;
        const completion = this.audioCompletion;
        this.audio = undefined; this.audioSession = undefined;
        this.audioOwner = undefined; this.audioCompletion = undefined;
        child?.kill();
        if (keepCall) session?.uplink?.clear();
        try { if (!keepCall) await session?.close(); } finally { completion?.resolve(); }
    }
    private takeMicrophone(): AiphoneSession | undefined {
        if (this.audioOwner !== 'microphone') return;
        const session = this.audioSession;
        this.audioGeneration++;
        if (this.audioWatchdog) clearTimeout(this.audioWatchdog);
        if (this.audio && session && this.audioCompletion)
            this.pausedMicrophone = { child: this.audio, session, completion: this.audioCompletion };
        this.audio = undefined; this.audioSession = undefined;
        this.audioOwner = undefined; this.audioCompletion = undefined;
        session?.uplink?.clear();
        // Keep the old decoder's RTSP input alive. Closing it here makes HomeKit
        // stop/restart its talkback connection during the handover. Its existing
        // session close handler still owns it if the call ends remotely.
        this.setIntercomState('Quick reply is using the microphone channel');
        return session && !session.closed ? session : undefined;
    }
    private discardPausedMicrophone() {
        const paused = this.pausedMicrophone;
        this.pausedMicrophone = undefined;
        if (!paused) return;
        paused.child.kill(); paused.completion.resolve();
    }
    private restoreMicrophone() {
        const paused = this.pausedMicrophone;
        this.pausedMicrophone = undefined;
        if (!paused) return false;
        if (paused.session.closed || paused.child.killed || paused.child.exitCode !== null || paused.child.signalCode !== null) {
            paused.completion.resolve(); return false;
        }
        this.audio = paused.child; this.audioSession = paused.session;
        this.audioOwner = 'microphone'; this.audioCompletion = paused.completion;
        paused.session.uplink?.clear();
        if (paused.session.uplink) paused.session.uplink.maxBufferedFrames = 8;
        this.setIntercomState('Reply finished; microphone restored');
        return true;
    }
    async playReply(): Promise<void> {
        if (!this.accessoryOptions().reply) throw new Error('Quick reply is not enabled');
        if (this.replyRunning || ((this.startingAudio || this.audio) && this.audioOwner !== 'microphone'))
            throw new Error('Another recording is already using the doorbell');
        if (this.startingAudio && !this.microphoneStart) throw new Error('Microphone is starting. Try again shortly.');
        this.replyRunning = true;
        const generation = ++this.replyGeneration;
        this.replyStatus = 'Preparing reply';
        void this.settingsChanged().catch(() => {});
        try {
            // Validate before opening a cloud session, so bad paths cannot answer a visitor.
            const path = await readableReplyFile(this.storage.getItem('replyPath') || '');
            if (generation !== this.replyGeneration) return;
            const media = await sdk.mediaManager.createFFmpegMediaObject({ inputArguments: ['-i', path] });
            if (generation !== this.replyGeneration) return;
            // A microphone being negotiated owns its acceptance request. Let it
            // finish, then hand over without cancelling or recreating the call.
            if (this.microphoneStart) await this.microphoneStart;
            if (generation !== this.replyGeneration) return;
            const session = this.takeMicrophone();
            const run = await this.startAudio(media, 'reply', session);
            if (generation === this.replyGeneration) this.replyStatus = 'Playing reply';
            void this.settingsChanged().catch(() => {});
            await run.done;
            if (generation === this.replyGeneration)
                this.replyStatus = this.replySession?.closed ? 'Call ended; reply stopped' : 'Reply finished; call remains active';
        } catch (error) {
            if (generation !== this.replyGeneration) return;
            this.replyStatus = `Failed: ${safeAudioError((error as Error).message)}`;
            throw error;
        } finally {
            const restored = this.restoreMicrophone();
            if (restored) this.replyStatus += '; microphone restored';
            this.replySession = undefined;
            this.replyRunning = false;
            this.console.log(`Quick reply: ${this.replyStatus}`);
            void this.settingsChanged().catch(() => {});
        }
    }
    async stopReply(resumeMicrophone = true): Promise<void> {
        this.replyGeneration++;
        if (this.replyRunning) this.replyStatus = 'Reply stopped';
        if (!resumeMicrophone) this.discardPausedMicrophone();
        if (this.replyRunning && this.audioOwner !== 'microphone') this.replySession?.uplink?.clear();
        await this.stopAudio('reply', true);
        void this.settingsChanged().catch(() => {});
    }
    async refreshSettings() {
        this.online = this.isExperimental() || this.controller.online;
        if (!this.isExperimental() && this.statusVideo) {
            await this.statusVideo.close(); this.statusVideo = undefined;
        }
        if (this.accessoryOptions().reply) {
            try {
                await readableReplyFile(this.getReplyPath());
                this.console.log(this.getReplyPath() ? 'Custom reply audio ready' : 'Bundled reply audio ready');
            } catch (error) { this.console.error((error as Error).message); }
        }
        await this.settingsChanged();
    }
    getReplyPath() { return this.storage.getItem('replyPath') || ''; }
    async getSettings(): Promise<Setting[]> {
        return [
            { key: 'connection', group: 'Status', title: 'Connection', value: this.controller.online ? 'Connected' : 'Disconnected (reconnecting)', readonly: true },
            { key: 'call', group: 'Status', title: 'Doorbell', value: this.doorbellState(), readonly: true },
        ];
    }
    async putSetting(key: string, value: SettingValue) {
        if (key === 'answer') { const session = await this.controller.ensureVideo(); await session.answer(); }
        else if (key === 'hangup') { await this.stopReply(false); await this.stopAudio(); await this.controller.hangup(); }
        else if (key === 'unlock') {
            if (!this.accessoryOptions().unlock) throw new Error('Unlock switch is not enabled');
            this.controller.unlock();
        }
        else if (key === 'replyPath') {
            const path = String(value).trim();
            if (path && !path.startsWith('/')) throw new Error('Enter an absolute audio path on the Scrypted host');
            this.storage.setItem(key, path);
            await this.refreshSettings();
            return;
        } else if (key === 'playReply') {
            await this.playReply();
        } else throw new Error(`Unknown setting: ${key}`);
        await this.settingsChanged();
    }
    async close() {
        this.closing = true;
        this.earlyViews?.forEach(intent => intent.cancel()); this.earlyViews?.clear();
        this.settingsRefreshTimers.forEach(clearTimeout);
        this.setRingState(false);
        this.snapshotCache.stop();
        await this.stopReply(false);
        await this.stopAudio();
        await this.statusVideo?.close();
        await this.rtsp.close();
        await this.controller.close();
    }
}

class UnlockPulse extends ScryptedDeviceBase implements OnOff {
    private reset?: NodeJS.Timeout;
    private released = false;
    constructor(private doorbell: () => Doorbell, private enabled: () => boolean) { super(UNLOCK); this.on = false; }
    async turnOn() {
        if (this.released || !this.enabled()) throw new Error('Unlock switch is not enabled');
        this.doorbell().controller.unlock();
        this.on = true;
        if (this.reset) clearTimeout(this.reset);
        this.reset = setTimeout(() => { this.on = false; }, 1000);
    }
    async turnOff() { this.on = false; }
    close() { this.released = true; if (this.reset) clearTimeout(this.reset); this.on = false; }
}

export class ReplySwitch extends ScryptedDeviceBase implements OnOff {
    private pending?: Promise<void>;
    private released = false;
    constructor(private doorbell: () => Doorbell) { super(REPLY); this.on = false; }
    async turnOn() {
        if (this.released) throw new Error('Quick reply is not enabled');
        if (this.pending) return;
        this.on = true;
        const job = this.pending = this.doorbell().playReply();
        // HomeKit writes must acknowledge promptly, even when cloud setup takes seconds.
        void job.catch(error => this.console.error(`Quick reply: ${(error as Error).message}`)).finally(() => {
            if (this.pending === job) { this.pending = undefined; this.on = false; }
        });
    }
    async turnOff() {
        if (this.pending) await this.doorbell().stopReply();
        this.on = false;
    }
    async close() {
        this.released = true;
        await this.turnOff();
        await this.pending?.catch(() => {});
    }
}

/** A read-only contact pulse for Apple's sensor-triggered home automations. */
export class RingSensor extends ScryptedDeviceBase implements BinarySensor {
    private released = false;
    constructor(ringing = false) { super(RING_SENSOR); this.binaryState = ringing; }
    setRinging(ringing: boolean) {
        if (this.released) return;
        this.binaryState = ringing;
    }
    close() {
        this.released = true;
        this.binaryState = false;
    }
}

export default class AiphoneProvider extends ScryptedDeviceBase implements DeviceProvider, Settings, Readme {
    private credentials?: Credentials;
    private doorbell?: Doorbell;
    private unlock?: UnlockPulse;
    private reply?: ReplySwitch;
    private ringSensor?: RingSensor;
    private busy = false;
    private status = 'Not paired';
    private readonly initialized: Promise<void>;
    constructor() {
        super();
        this.initialized = this.initialize();
        void this.initialized.catch(err => { this.status = `Initialization failed: ${err.message}`; this.console.error(this.status); });
    }
    private async initialize() {
        const saved = this.storage.getItem('credentials');
        if (saved) { this.credentials = credentialsFromJSON(saved); this.status = 'Paired'; }
        await this.syncDevices();
    }
    private async syncDevices() {
        if (!this.credentials || !this.ringSensorEnabled) { this.ringSensor?.close(); this.ringSensor = undefined; }
        if (!this.accessoryOptions.unlock) { this.unlock?.close(); this.unlock = undefined; }
        if (!this.accessoryOptions.reply) {
            await this.reply?.close(); this.reply = undefined;
            await this.doorbell?.stopReply();
        }
        await sdk.deviceManager.onDevicesChanged({ devices: this.credentials ? [
            { nativeId: DOORBELL, name: 'Aiphone WP-2MED', type: ScryptedDeviceType.Doorbell,
                interfaces: cameraInterfaces, info: { manufacturer: 'Aiphone', model: 'WP-2MED', mac: this.credentials.unit_mac } },
            ...(this.accessoryOptions.unlock ? [{ nativeId: UNLOCK, name: 'Aiphone Unlock', type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff], info: { manufacturer: 'Aiphone', model: 'WP-2MED unlock pulse' } }] : []),
            ...(this.accessoryOptions.reply ? [{ nativeId: REPLY, name: 'Aiphone Quick Reply', type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff], info: { manufacturer: 'Aiphone', model: 'WP-2MED prerecorded reply' } }] : []),
            ...(this.ringSensorEnabled ? [{ nativeId: RING_SENSOR, name: 'Aiphone Ring Sensor', type: ScryptedDeviceType.Sensor,
                interfaces: [ScryptedInterface.BinarySensor], info: { manufacturer: 'Aiphone', model: 'WP-2MED ring sensor' } }] : []),
        ] : [] });
        if (this.credentials) this.getDoorbell();
        await this.doorbell?.refreshSettings();
    }
    private get accessoryOptions(): AccessoryOptions {
        return { unlock: this.storage.getItem('enableUnlock') === 'true', reply: this.storage.getItem('enableReply') === 'true' };
    }
    private get ringSensorEnabled() { return this.storage.getItem('enableRingSensor') === 'true'; }
    private getRingSensor() { return this.ringSensor ||= new RingSensor(this.doorbell?.binaryState === true); }
    private getDoorbell() {
        if (!this.credentials) throw new Error('Pair the doorbell in the plugin settings first');
        return this.doorbell ||= new Doorbell(this.credentials, () => this.accessoryOptions, () => this.storage.getItem('videoMode') === 'status-osd',
            () => { const mode = this.storage.getItem('autoAnswerMode'); return mode === 'ringing' || mode === 'always' ? mode : 'off'; },
            ringing => {
                if (!this.ringSensorEnabled) return;
                if (ringing) this.getRingSensor().setRinging(true);
                else this.ringSensor?.setRinging(false);
            });
    }
    async getDevice(nativeId: string) {
        if (nativeId === DOORBELL) return this.getDoorbell();
        if (nativeId === UNLOCK && this.accessoryOptions.unlock)
            return this.unlock ||= new UnlockPulse(() => this.getDoorbell(), () => this.accessoryOptions.unlock);
        if (nativeId === REPLY && this.accessoryOptions.reply)
            return this.reply ||= new ReplySwitch(() => this.getDoorbell());
        if (nativeId === RING_SENSOR && this.credentials && this.ringSensorEnabled) return this.getRingSensor();
        throw new Error('Unknown Aiphone device');
    }
    async releaseDevice(_id: string, nativeId: string) {
        if (nativeId === DOORBELL) {
            this.ringSensor?.close(); this.ringSensor = undefined;
            await this.reply?.close(); this.reply = undefined; await this.doorbell?.close(); this.doorbell = undefined;
        }
        if (nativeId === UNLOCK) { this.unlock?.close(); this.unlock = undefined; }
        if (nativeId === REPLY) { await this.reply?.close(); this.reply = undefined; }
        if (nativeId === RING_SENSOR) { this.ringSensor?.close(); this.ringSensor = undefined; }
    }
    async getSettings(): Promise<Setting[]> {
        await this.initialized.catch(() => {});
        return [
            { key: 'status', group: 'Pairing', title: 'Pairing Status', value: this.status, readonly: true },
            { key: 'termname', group: 'Pairing', title: 'Terminal Name', value: this.storage.getItem('termname') || 'Scrypted', description: 'Name shown on the indoor station.' },
            { key: 'address', group: 'Pairing', title: 'Discovery Address (Optional)', value: this.storage.getItem('address') || '', description: 'Leave blank for automatic discovery, or enter the indoor station IPv4 address.' },
            { key: 'bindAddress', group: 'Pairing', title: 'Local IPv4 Address (Optional)', value: this.storage.getItem('bindAddress') || '', description: 'Optional local IPv4 address for pairing on hosts with multiple network adapters. Docker requires host networking.' },
            { key: 'pair', group: 'Pairing', title: 'Start Pairing', type: 'button', description: 'Put the indoor station in Add Terminal mode, then start pairing. This creates a separate terminal for Scrypted.' },
            { key: 'enableUnlock', group: 'Accessories', title: 'Enable Unlock Switch', type: 'boolean', value: this.accessoryOptions.unlock,
                description: 'Add an unlock switch that sends a door-release command when turned on.' },
            { key: 'enableReply', group: 'Accessories', title: 'Enable Quick Reply', type: 'boolean', value: this.accessoryOptions.reply,
                description: 'Add a switch that answers the doorbell and plays a recorded message. The switch turns off when playback finishes.' },
            { key: 'enableRingSensor', group: 'Accessories', title: 'Enable Ring Sensor', type: 'boolean', value: this.ringSensorEnabled,
                description: 'Add a contact sensor for HomeKit automations. Open means the doorbell is ringing; Closed means ringing has ended. Enable the HomeKit extension on the sensor to use it in Apple Home.' },
            { key: 'videoMode', group: 'Experimental', title: 'Video Mode (Experimental)', type: 'string',
                choices: [DIRECT_MODE, STATUS_MODE], value: this.storage.getItem('videoMode') === 'status-osd' ? STATUS_MODE : DIRECT_MODE,
                description: 'Direct forwards the original video. Status + OSD shows a cached image while connecting, then live video with status text at 640x480, 10 fps. OSD uses more CPU and adds delay. Reopen the viewer after changing this setting.' },
            { key: 'autoAnswerMode', group: 'Experimental', title: 'Auto Answer on Live View (Experimental)', type: 'string',
                choices: [AUTO_ANSWER_OFF, AUTO_ANSWER_RINGING, AUTO_ANSWER_ALWAYS],
                value: this.storage.getItem('autoAnswerMode') === 'always' ? AUTO_ANSWER_ALWAYS
                    : this.storage.getItem('autoAnswerMode') === 'ringing' ? AUTO_ANSWER_RINGING : AUTO_ANSWER_OFF,
                description: 'Answer when you open live video: Off, While Ringing, or Always. The phone microphone stays off until you tap Talk. Answering may stop ringing on other terminals. Applies the next time you open the viewer.' },
            ...(this.doorbell && this.accessoryOptions.reply ? [{ key: 'replyPath', group: 'Quick Reply', title: 'Reply Audio Path',
                value: this.doorbell.getReplyPath(), description: 'Leave blank for the included Japanese reply. To use your own recording, enter its absolute path inside the Scrypted host or container.' }] : []),
        ];
    }
    async putSetting(key: string, value: SettingValue) {
        await this.initialized.catch(() => {});
        if (this.busy) throw new Error('Pairing is in progress. Please wait.');
        if (key === 'autoAnswerMode') {
            const modes = new Map<string, AutoAnswerMode>([[AUTO_ANSWER_OFF, 'off'], [AUTO_ANSWER_RINGING, 'ringing'], [AUTO_ANSWER_ALWAYS, 'always']]);
            const mode = modes.get(String(value));
            if (!mode) throw new Error('Unknown auto-answer mode');
            this.storage.setItem(key, mode);
            this.console.log(`Auto answer on live view: ${value}; applies on next live view`);
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'videoMode') {
            if (value !== DIRECT_MODE && value !== STATUS_MODE) throw new Error('Unknown video mode');
            this.storage.setItem(key, value === STATUS_MODE ? 'status-osd' : 'direct');
            await this.doorbell?.refreshSettings();
            this.console.log(`Video mode: ${value}; reopen the viewer to apply`);
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'replyPath') {
            if (!this.accessoryOptions.reply) throw new Error('Quick reply is not enabled');
            await this.getDoorbell().putSetting(key, value);
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'enableUnlock' || key === 'enableReply' || key === 'enableRingSensor') {
            const enabled = value === true || value === 'true';
            this.storage.setItem(key, String(enabled));
            await this.syncDevices();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (['termname', 'address', 'bindAddress'].includes(key)) {
            this.storage.setItem(key, String(value).trim());
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key !== 'pair' && key !== 'probe') throw new Error(`Unknown setting: ${key}`);
        this.busy = true;
        try {
            const options: PairingOptions = {
                termname: this.storage.getItem('termname') || 'Scrypted', address: this.storage.getItem('address') || undefined,
                bindAddress: this.storage.getItem('bindAddress') || undefined,
                diagnostics: message => this.console.log(`[Pairing] ${message}`),
            };
            this.console.log(`[Pairing] ${pairingNetworkSummary()}`);
            if (key === 'probe') { await probePairingNetwork(options); return; }
            const credentials = await pairAiphone(options, text => { this.status = text; void this.onDeviceEvent(ScryptedInterface.Settings, undefined); });
            const validated = credentialsFromJSON(credentials);
            this.ringSensor?.close(); this.ringSensor = undefined;
            await this.doorbell?.close(); this.doorbell = undefined;
            this.credentials = validated;
            this.storage.setItem('credentials', JSON.stringify(validated));
            this.status = 'Paired';
            await this.syncDevices();
        } catch (err) { this.status = `Failed: ${(err as Error).message}`; this.console.error(this.status); throw err; }
        finally { this.busy = false; await this.onDeviceEvent(ScryptedInterface.Settings, undefined); }
    }
    async getReadmeMarkdown() {
        return `# Aiphone WP-2MED

Put the indoor station in **Add Terminal** mode, then click **Start Pairing** in the plugin settings. Enable the doorbell's HomeKit extension to add it to Apple Home.

**Accessories** offers optional Unlock, Quick Reply, and Ring Sensor devices. Enable each device's HomeKit extension to use it in Apple Home. Quick Reply plays the included Japanese message or the recording in **Reply Audio Path**.

**Experimental** offers status video with OSD and auto answer when opening live video. Tap **Talk** to enable the phone microphone.

Pairing requires Docker host networking. Keep continuous video prebuffering off.`;
    }
}
