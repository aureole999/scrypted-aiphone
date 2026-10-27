# Aiphone WP-2MED for Scrypted

Connect an Aiphone WP-2MED doorbell to Scrypted and Apple Home. Supports live video, cached snapshots, ringing notifications, and two-way audio.

## Install

Requires Node.js 22+ and FFmpeg. The package is not yet on npm; deploy from source:

```sh
npm ci
npm run check
npm run scrypted-deploy -- SCRYPTED_IP
```

Replace `SCRYPTED_IP` with your Scrypted server address.

## Pair

1. Open the plugin settings and enter a **Terminal Name**.
2. Put the indoor station in **Add Terminal** mode.
3. Click **Start Pairing**.
4. Enable the doorbell's HomeKit extension to add it to Apple Home.

Pairing requires access to the indoor station on UDP ports 51711/51712. Docker needs host networking. Normal use requires an Aiphone cloud connection. Keep continuous video prebuffering off.

## Options

Under **Accessories**, optionally enable:

- **Unlock Switch** — release the door lock.
- **Quick Reply** — answer and play a recording, then keep the call connected.
- **Ring Sensor** — expose ringing to Apple Home automations as a contact sensor.

Enable each accessory's HomeKit extension to add it to Apple Home. For replies when nobody is home, create an automation: **Ring Sensor opens → When nobody is home → Quick Reply on**.

Quick Reply includes a Japanese delivery message. Set **Reply Audio Path** to a recording inside the Scrypted host, or leave it blank to use the included audio.

Under **Experimental**:

- **Video Mode** — choose Direct or Status + OSD. OSD shows connection and call status; it uses more CPU and adds delay.
- **Auto Answer on Live View** — choose Off, While Ringing, or Always. Tap **Talk** to enable the phone microphone. Answering may stop ringing on other terminals.

Reopen the viewer after changing experimental options. Snapshots use the last cached image without opening a new video connection.

## Development

Run `npm run check` for tests, build verification, and dependency auditing. CI checks Node.js 22 and 24. See [CHANGELOG.md](CHANGELOG.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
