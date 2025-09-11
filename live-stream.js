// live-stream.js

import { state } from './state.js';
import * as config from './config.js';
import * as cryptoUtils from './cryptoUtils.js';
import * as dom from './dom.js';
import * as ui from './ui.js';

// Função interna, usada apenas por startLiveStream dentro deste módulo
function createStreamerWorker(options) {
    const workerCode = `
            const width = ${options.width};
            const height = ${options.height};
            const quality = ${options.jpegQuality};
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            
            self.onmessage = async (event) => {
                if (event.data.bitmap) {
                    const videoRatio = event.data.bitmap.width / event.data.bitmap.height;
                    const canvasRatio = width / height;
                    let drawWidth, drawHeight, x, y;

                    if (videoRatio > canvasRatio) { 
                        drawWidth = width;
                        drawHeight = width / videoRatio;
                        x = 0;
                        y = (height - drawHeight) / 2;
                    } else {
                        drawHeight = height;
                        drawWidth = height * videoRatio;
                        y = 0;
                        x = (width - drawWidth) / 2;
                    }
                    
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(event.data.bitmap, x, y, drawWidth, drawHeight);
                    event.data.bitmap.close();
                    
                    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
                    const buffer = await blob.arrayBuffer();
                    self.postMessage({ frame: buffer }, [buffer]);
                }
            };
        `;
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = async (event) => {
        if (state.streamr && state.currentLiveStreamId && event.data.frame) {
            const frameData = event.data.frame;

            const password = state.roomPasswords.get(state.currentRoomId);
            const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
            let payload;

            if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(frameData, state.currentEpochKey);
                payload = {
                    roomId: state.currentRoomId,
                    streamId: state.currentLiveStreamId,
                    type: 'pfs_encrypted_frame',
                    epochId: state.currentEpochId,
                    ...encrypted
                };
            } else if (password) {
                const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                const encrypted = await cryptoUtils.encryptMessage(frameData, key);
                payload = {
                    roomId: state.currentRoomId,
                    streamId: state.currentLiveStreamId,
                    encryptedFrame: encrypted.content,
                    iv: encrypted.iv
                };
            } else {
                payload = {
                    roomId: state.currentRoomId,
                    streamId: state.currentLiveStreamId,
                    frame: cryptoUtils.arrayBufferToBase64(frameData)
                };
            }

            state.streamr.publish(config.VIDEO_STREAM_ID, payload);

            const localStreamInfo = state.remoteStreams.get(state.currentLiveStreamId);
            if (localStreamInfo && localStreamInfo.videoWorker) {
                localStreamInfo.videoWorker.postMessage({frame: frameData.slice(0)});
            }
        }
    };
    worker.onerror = (error) => {
        console.error("Error in streamer worker:", error);
    };
    return worker;
}


// Funções exportadas para serem usadas nos event listeners do app.js
export async function promptCameraSelection() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        if (videoDevices.length === 0) {
            ui.showCustomAlert("No Camera Found", "No camera devices were found.");
            return;
        }
        dom.cameraSelect.innerHTML = '';
        videoDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Camera ${dom.cameraSelect.options.length + 1}`;
            dom.cameraSelect.appendChild(option);
        });
        dom.cameraSelectModal.classList.remove('hidden');
    } catch (err) {
        ui.showCustomAlert("Device Error", "Could not access media devices.");
    }
}

export async function promptMicSelection() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioDevices = devices.filter(device => device.kind === 'audioinput');
        if (audioDevices.length === 0) {
            ui.showCustomAlert("No Microphone Found", "No microphone devices were found.");
            return;
        }
        dom.micSelect.innerHTML = '';
        audioDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${dom.micSelect.options.length + 1}`;
            dom.micSelect.appendChild(option);
        });
        dom.micSelectModal.classList.remove('hidden');
    } catch (err) {
        ui.showCustomAlert("Device Error", "Could not access media devices.");
    }
}

export async function startVideoStream(deviceId, options) {
    if (state.localMediaStream) await stopLiveStream();
    if (!state.streamr) return;
    try {
        const constraints = { video: { width: {ideal: options.width}, height: {ideal: options.height}, deviceId: deviceId ? {exact: deviceId} : undefined }, audio: true };
        state.localMediaStream = await navigator.mediaDevices.getUserMedia(constraints).catch(err => {
            delete constraints.audio;
            return navigator.mediaDevices.getUserMedia(constraints);
        });
        dom.localVideoPreview.srcObject = state.localMediaStream;
        dom.videoPreviewModal.classList.remove('hidden');
        state.currentStreamType = 'video';

        const videoTrack = state.localMediaStream.getVideoTracks()[0];
        if (videoTrack) {
            state.currentVideoTrack = videoTrack;
            try {
                if (videoTrack.getCapabilities().torch) dom.toggleFlashlightBtn.classList.remove('hidden');
            } catch (e) {}
        }
        state.streamerWorker = createStreamerWorker(options);
        const imageCapture = new ImageCapture(videoTrack);
        state.currentLiveStreamId = crypto.randomUUID();
        await state.streamr.publish(config.CHAT_STREAM_ID, { roomId: state.currentRoomId, type: 'start_stream', streamType: 'video', streamId: state.currentLiveStreamId, id: crypto.randomUUID(), nickname: state.myNickname, realAddress: state.myRealAddress });

        state.videoStreamInterval = setInterval(async () => {
            try {
                const imageBitmap = await imageCapture.grabFrame();
                state.streamerWorker.postMessage({bitmap: imageBitmap}, [imageBitmap]);
            } catch (e) {}
        }, 1000 / options.frameRate);

        if (state.localMediaStream.getAudioTracks().length > 0) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = state.audioContext.createMediaStreamSource(state.localMediaStream);
            state.audioProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);
            state.audioProcessor.onaudioprocess = async (e) => {
                const audioDataArray = Array.from(e.inputBuffer.getChannelData(0));
                const password = state.roomPasswords.get(state.currentRoomId);
                const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
                let payload;
                if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
                    const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(audioDataArray)), state.currentEpochKey);
                    payload = { roomId: state.currentRoomId, streamId: state.currentLiveStreamId, type: 'pfs_encrypted_audio', epochId: state.currentEpochId, ...encrypted };
                } else if (password) {
                    const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                    const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(audioDataArray)), key);
                    payload = { roomId: state.currentRoomId, streamId: state.currentLiveStreamId, encryptedAudio: encrypted.content, iv: encrypted.iv };
                } else {
                    payload = {roomId: state.currentRoomId, streamId: state.currentLiveStreamId, audioData: audioDataArray};
                }
                state.streamr.publish(config.AUDIO_STREAM_ID, payload);
            };
            source.connect(state.audioProcessor);
            // The line below was connecting the user's mic input to their own speakers.
            // By removing it, we prevent audio feedback during video streams.
            // state.audioProcessor.connect(state.audioContext.destination);
        }
    } catch (err) {
        ui.showCustomAlert("Access Denied", "Could not access camera/microphone.");
        await stopLiveStream();
    }
}

export async function startAudioStream(deviceId) {
    if (state.localMediaStream) await stopLiveStream();
    if (!state.streamr) return;
    try {
        const constraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined }, video: false };
        state.localMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        dom.audioPreviewModal.classList.remove('hidden');
        state.currentStreamType = 'audio';

        state.currentLiveStreamId = crypto.randomUUID();
        await state.streamr.publish(config.CHAT_STREAM_ID, { roomId: state.currentRoomId, type: 'start_stream', streamType: 'audio', streamId: state.currentLiveStreamId, id: crypto.randomUUID(), nickname: state.myNickname, realAddress: state.myRealAddress });

        if (state.localMediaStream.getAudioTracks().length > 0) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = state.audioContext.createMediaStreamSource(state.localMediaStream);
            state.audioProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);
            state.audioProcessor.onaudioprocess = async (e) => {
                const audioDataArray = Array.from(e.inputBuffer.getChannelData(0));
                const password = state.roomPasswords.get(state.currentRoomId);
                const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
                let payload;
                if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
                    const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(audioDataArray)), state.currentEpochKey);
                    payload = { roomId: state.currentRoomId, streamId: state.currentLiveStreamId, type: 'pfs_encrypted_audio', epochId: state.currentEpochId, ...encrypted };
                } else if (password) {
                    const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                    const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(audioDataArray)), key);
                    payload = { roomId: state.currentRoomId, streamId: state.currentLiveStreamId, encryptedAudio: encrypted.content, iv: encrypted.iv };
                } else {
                    payload = {roomId: state.currentRoomId, streamId: state.currentLiveStreamId, audioData: audioDataArray};
                }
                state.streamr.publish(config.AUDIO_STREAM_ID, payload);
            };
            source.connect(state.audioProcessor);
            state.audioProcessor.connect(state.audioContext.destination);
        }
    } catch (err) {
        ui.showCustomAlert("Access Denied", "Could not access microphone.");
        await stopLiveStream();
    }
}

export async function stopLiveStream() {
    if (state.videoStreamInterval) clearInterval(state.videoStreamInterval);
    state.videoStreamInterval = null;
    
    if (state.currentStreamType === 'video') {
        if (state.currentVideoTrack && state.isFlashlightOn) {
            try { await state.currentVideoTrack.applyConstraints({advanced: [{torch: false}]}); } catch (e) {}
        }
        state.isFlashlightOn = false;
        state.currentVideoTrack = null;
        dom.toggleFlashlightBtn.classList.add('hidden');
        if (state.streamerWorker) {
            state.streamerWorker.terminate();
            state.streamerWorker = null;
        }
    }
    
    if (state.audioProcessor) {
        state.audioProcessor.disconnect();
        state.audioProcessor = null;
    }
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }
    if (state.localMediaStream) {
        state.localMediaStream.getTracks().forEach(track => track.stop());
        state.localMediaStream = null;
    }

    dom.videoPreviewModal.classList.add('hidden');
    dom.audioPreviewModal.classList.add('hidden');
    
    if (state.currentLiveStreamId && state.streamr) {
        await state.streamr.publish(config.CHAT_STREAM_ID, {
            roomId: state.currentRoomId, type: 'stop_stream', streamId: state.currentLiveStreamId, id: crypto.randomUUID(), nickname: state.myNickname, realAddress: state.myRealAddress
        });
        state.currentLiveStreamId = null;
    }
    state.currentStreamType = null;
}


