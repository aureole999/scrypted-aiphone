/** Live RTSP audio is already clocked; -re is only needed for prerecorded files. */
export function intercomArguments(input: string[]): string[] {
    const live = input.some(value => /^(?:rtsp|rtsps|tcp|udp|rtp|srt):\/\//i.test(value));
    return ['-hide_banner', '-loglevel', 'error',
        ...(live ? ['-analyzeduration', '100000', '-probesize', '32768'] : ['-re']),
        ...input, '-vn', '-ac', '1', '-ar', '8000', '-acodec', 'pcm_mulaw', '-f', 'mulaw', 'pipe:1'];
}
export function safeAudioError(error: string): string {
    return error.replace(/(?:rtsp|rtsps|tcp|udp|rtp|https?):\/\/[^\s]+/gi, '[audio input]').trim().slice(-2000);
}
