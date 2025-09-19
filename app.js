// app.js

import * as config from './config.js';
import * as dom from './dom.js';
import * as ui from './ui.js';
import { state } from './state.js';
import * as utils from './utils.js';
import * as db from './db.js';
import * as fileTransfer from './file-transfer.js';
import * as liveStream from './live-stream.js';
import * as workers from './workers.js';
import * as streamr from './streamr.js';

// --- EVENT LISTENERS ---
function setupEventListeners() {
    function adjustLayoutHeight() {
        const vh = window.innerHeight;
        dom.chatUI.style.height = `${vh}px`;
        dom.streamerLayout.style.height = `${vh}px`;
        if (dom.messagesContainer) dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
        if (dom.streamerChatContainer) dom.streamerChatContainer.scrollTop = dom.streamerChatContainer.scrollHeight;
    }
    window.addEventListener('resize', adjustLayoutHeight);
    adjustLayoutHeight();

    dom.sendImageBtn.addEventListener('click', () => { state.selectedFileIntent = 'image'; dom.imageInputFile.click(); });
    dom.sendVideoBtn.addEventListener('click', () => { state.selectedFileIntent = 'video'; dom.videoInputFile.click(); });
    dom.sendFileBtn.addEventListener('click', () => { state.selectedFileIntent = 'file'; dom.genericFileInput.click(); });

    function handleFileSelection(event) {
        if (event.target.files && event.target.files[0]) {
            const file = event.target.files[0];
            let error = null;
            if (state.selectedFileIntent === 'image' && !config.ALLOWED_IMAGE_TYPES.includes(file.type)) {
                error = `Invalid type. Allowed: ${config.ALLOWED_IMAGE_TYPES.join(', ')}.`;
            } else if (state.selectedFileIntent === 'video' && !config.ALLOWED_VIDEO_TYPES.includes(file.type)) {
                error = `Invalid type. Allowed: ${config.ALLOWED_VIDEO_TYPES.join(', ')}.`;
            }
            if (error) {
                ui.showCustomAlert('File Error', error);
                event.target.value = ''; return;
            }
            state.selectedFile = file;
            dom.confirmFileName.textContent = state.selectedFile.name;
            dom.confirmFileSize.textContent = `${(state.selectedFile.size / 1024 / 1024).toFixed(2)} MB`;
            dom.fileConfirmModal.classList.remove('hidden');
            dom.attachMenu.classList.add('hidden');
            event.target.value = '';
        }
    }

    dom.imageInputFile.addEventListener('change', handleFileSelection);
    dom.videoInputFile.addEventListener('change', handleFileSelection);
    dom.genericFileInput.addEventListener('change', handleFileSelection);

    dom.cancelSendBtn.addEventListener('click', () => { state.selectedFile = null; dom.fileConfirmModal.classList.add('hidden'); });

    dom.confirmSendBtn.addEventListener('click', async () => {
        if (!state.selectedFile) return;
        const file = state.selectedFile;
        state.selectedFile = null;
        dom.fileConfirmModal.classList.add('hidden');

        if (state.selectedFileIntent === 'image') {
            const dataId = crypto.randomUUID();
            const messagePayload = { type: 'image', imageId: dataId, id: crypto.randomUUID(), nickname: state.myNickname, realAddress: state.myRealAddress };
            await streamr.sendImage(file, messagePayload, dataId);
        } else { // File or Video
            const tempId = 'temp-file-' + crypto.randomUUID();
            const tempMsgDiv = document.createElement('div');
            tempMsgDiv.id = tempId;
            tempMsgDiv.className = 'message-entry own-message';
            
            const container = state.currentRoomType === 'streamer' ? dom.streamerChatContainer : dom.messagesContainer;

            if (state.selectedFileIntent === 'video') {
                const localUrl = URL.createObjectURL(file);
                tempMsgDiv.innerHTML = `<div class="message-bubble"><div class="message-content relative"><video controls muted autoplay loop class="max-w-xs rounded-md" src="${localUrl}"></video><div class="absolute top-2 left-2 bg-black bg-opacity-60 text-white text-xs rounded-md px-2 py-1 flex items-center"><div class="spinner mr-2"></div><span>Processing...</span></div></div></div>`;
            } else {
                tempMsgDiv.innerHTML = `<div class="message-bubble"><div class="message-content flex items-center"><div class="spinner"></div><span>Processing ${utils.sanitizeHTML(file.name)}...</span></div></div>`;
            }
            container.appendChild(tempMsgDiv);
            container.scrollTop = container.scrollHeight;

            state.localFiles.set(tempId, {file: file});
            const fileStream = file.stream();
            const fileData = {name: file.name, size: file.size, type: file.type};
            state.fileWorker.postMessage({fileStream, fileData, tempId, intent: state.selectedFileIntent}, [fileStream]);
        }
    });

    dom.goLiveBtn.addEventListener('click', () => { dom.streamSettingsModal.classList.remove('hidden'); dom.attachMenu.classList.add('hidden'); });
    dom.goLiveAudioBtn.addEventListener('click', () => { liveStream.promptMicSelection(); dom.attachMenu.classList.add('hidden'); });
    dom.cancelStreamSettingsBtn.addEventListener('click', () => dom.streamSettingsModal.classList.add('hidden'));

    dom.continueToCameraBtn.addEventListener('click', () => {
        const resolution = dom.resolutionSelect.value.split('x');
        state.streamSettings.width = parseInt(resolution[0], 10);
        state.streamSettings.height = parseInt(resolution[1], 10);
        state.streamSettings.frameRate = parseInt(dom.fpsSlider.value, 10);
        state.streamSettings.jpegQuality = parseInt(dom.qualitySlider.value, 10) / 100;
        dom.streamSettingsModal.classList.add('hidden');
        liveStream.promptCameraSelection();
    });

    dom.fpsSlider.addEventListener('input', (e) => dom.fpsValue.textContent = e.target.value);
    dom.qualitySlider.addEventListener('input', (e) => dom.qualityValue.textContent = `${e.target.value}%`);
    dom.startStreamBtn.addEventListener('click', () => { liveStream.startVideoStream(dom.cameraSelect.value, state.streamSettings); dom.cameraSelectModal.classList.add('hidden'); });
    dom.cancelStreamBtn.addEventListener('click', () => dom.cameraSelectModal.classList.add('hidden'));
    dom.startAudioStreamBtn.addEventListener('click', () => { liveStream.startAudioStream(dom.micSelect.value); dom.micSelectModal.classList.add('hidden'); });
    dom.cancelAudioStreamBtn.addEventListener('click', () => dom.micSelectModal.classList.add('hidden'));
    dom.stopVideoStreamBtn.addEventListener('click', liveStream.stopLiveStream);
    dom.stopAudioStreamBtn.addEventListener('click', liveStream.stopLiveStream);

    dom.toggleFlashlightBtn.addEventListener('click', async () => {
        if (state.currentVideoTrack) {
            try {
                state.isFlashlightOn = !state.isFlashlightOn;
                await state.currentVideoTrack.applyConstraints({ advanced: [{torch: state.isFlashlightOn}] });
                dom.toggleFlashlightBtn.textContent = state.isFlashlightOn ? 'Flashlight On' : 'Flashlight';
            } catch (e) {
                ui.showCustomAlert('Flashlight Error', 'Could not toggle flashlight.');
                state.isFlashlightOn = !state.isFlashlightOn;
            }
        }
    });

    dom.opacitySlider.addEventListener('input', (e) => dom.videoPreviewModal.style.opacity = e.target.value / 100);

    const messageClickHandler = async (e) => {
        const target = e.target;
        const seal = target.closest('.message-seal');
        if (seal) {
            const sealType = seal.dataset.sealType;
            ui.showCustomAlert(sealType === 'live' ? 'Verified Live 🛡️' : 'Historical 🕒', sealType === 'live' ? 'This message was received directly from the network and is cryptographically signed by the sender.' : 'This message is part of a conversation history shared by another user. Its content cannot be guaranteed.');
        }

        if (target.closest('.verification-seal')) {
            ui.showCustomAlert('Verified User ✅', 'User has proven ownership of the wallet address.');
        }

        const fullscreenBtn = target.closest('.fullscreen-btn');
        if (fullscreenBtn) {
            const canvas = document.getElementById(`stream-${fullscreenBtn.dataset.streamId}`);
            if (canvas) {
                if (canvas.requestFullscreen) canvas.requestFullscreen();
                else if (canvas.webkitRequestFullscreen) canvas.webkitRequestFullscreen();
            }
        }

        const fileButton = target.closest('button[data-file-id]');
        if (fileButton) {
            const { fileId, action } = fileButton.dataset;
            if (action === 'start-download') fileTransfer.startDownload(fileId);
            else if (action === 'cancel-download') fileTransfer.cancelDownload(fileId);
        }

        const actionsContainer = target.closest('.message-actions');
        if (actionsContainer) {
            if (target.classList.contains('react-button')) {
                let picker = document.getElementById('reactionPicker');
                if (!picker) {
                    picker = document.getElementById('reactionPickerTemplate').cloneNode(true);
                    picker.id = 'reactionPicker'; document.body.appendChild(picker);
                }
                picker.style.display = 'flex';
                const rect = target.getBoundingClientRect();
                picker.style.top = `${rect.top - picker.offsetHeight - 5}px`;
                const idealLeft = rect.left - (picker.offsetWidth / 2) + (rect.width / 2);
                picker.style.left = `${Math.max(10, Math.min(idealLeft, window.innerWidth - picker.offsetWidth - 10))}px`;
                picker.dataset.messageId = target.dataset.messageId;
            } else if (target.classList.contains('reply-button')) {
                startReply(target.dataset.messageId);
            }
        }

        if (target.classList.contains('reaction-badge')) {
            streamr.sendReaction(target.dataset.messageId, target.dataset.emoji);
        }

        const replySnippet = target.closest('.reply-snippet');
        if (replySnippet) {
            const originalMessage = document.getElementById(`msg-${replySnippet.dataset.scrollTo}`);
            if (originalMessage) {
                originalMessage.scrollIntoView({behavior: 'smooth', block: 'center'});
                originalMessage.classList.add('highlighted');
                setTimeout(() => originalMessage.classList.remove('highlighted'), 1000);
            }
        }
    };
    
    dom.messagesContainer.addEventListener('click', messageClickHandler);
    dom.streamerChatContainer.addEventListener('click', messageClickHandler);

    const emojis = [
        '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
        '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
        '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩',
        '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣',
        '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
        '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗',
        '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯',
        '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐',
        '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈',
        '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '🚀', '👾',
        '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿',
        '😾', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞',
        '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
        '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
        '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦵', '🦿', '🦶', '👂',
        '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄', '❤️'
    ];
    dom.emojiPicker.innerHTML = '';
    emojis.forEach(emoji => {
        const span = document.createElement('span'); span.textContent = emoji;
        span.addEventListener('click', () => {
             const input = state.currentRoomType === 'streamer' ? dom.messageInputStreamer : dom.messageInput;
             input.value += emoji;
        });
        dom.emojiPicker.appendChild(span);
    });

    dom.attachBtn.addEventListener('click', (e) => { e.stopPropagation(); dom.emojiPicker.classList.add('hidden'); dom.attachMenu.classList.toggle('hidden'); });
    dom.emojiBtn.addEventListener('click', (e) => { e.stopPropagation(); dom.attachMenu.classList.add('hidden'); dom.emojiPicker.classList.toggle('hidden'); });

    // Send message listeners for both UIs
    dom.sendBtn.addEventListener('click', streamr.sendMessage);
    dom.messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); streamr.sendMessage(); } });
    
    dom.sendBtnStreamer.addEventListener('click', streamr.sendMessage);
    dom.messageInputStreamer.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); streamr.sendMessage(); } });
    

    const typingHandler = () => {
        if (!state.isTypingTimeout) {
            streamr.sendTypingSignal();
        } else {
            clearTimeout(state.isTypingTimeout);
        }
        state.isTypingTimeout = setTimeout(() => { state.isTypingTimeout = null; }, config.TYPING_INDICATOR_TIMEOUT - 50);
    };
    dom.messageInput.addEventListener('input', typingHandler);
    dom.messageInputStreamer.addEventListener('input', typingHandler);
    
    // Auto-resize textarea
    const autoResizeHandler = function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    };
    dom.messageInput.addEventListener('input', autoResizeHandler);
    dom.messageInputStreamer.addEventListener('input', autoResizeHandler);
    
    dom.chatOpacitySlider.addEventListener('input', (e) => {
        // Convert hex #1b1b1b to rgb(27, 27, 27) and apply opacity
        dom.streamerChatPanel.style.backgroundColor = `rgba(27, 27, 27, ${e.target.value / 100})`;
    });
    
    // New listeners for streamer room controls
    dom.backToLobbyBtn.addEventListener('click', () => streamr.switchRoom('Lobby'));
    
    dom.chatSettingsToggle.addEventListener('click', () => {
        dom.chatSettingsContainer.classList.toggle('hidden');
        dom.chatSettingsToggle.classList.toggle('rotate-180');
    });

    dom.onlineHeader.addEventListener('click', (e) => { e.stopPropagation(); dom.usersList.classList.toggle('hidden'); dom.onlineHeader.querySelector('svg').classList.toggle('rotate-180'); });
    dom.aboutBtn.addEventListener('click', () => dom.aboutModal.classList.remove('hidden'));
    dom.closeModalBtn.addEventListener('click', () => dom.aboutModal.classList.add('hidden'));
    dom.aboutModal.addEventListener('click', (e) => { if (e.target === dom.aboutModal) dom.aboutModal.classList.add('hidden'); });

    dom.nicknameBtn.addEventListener('click', () => {
        const nicknameKey = state.myRealAddress || state.myPublisherId;
        dom.nicknameInput.value = sessionStorage.getItem(`nickname_${nicknameKey}`) || '';
        dom.ghostModeCheckbox.checked = state.isGhostMode;
        dom.nicknameModal.classList.remove('hidden');
    });

    dom.saveNicknameBtn.addEventListener('click', () => {
        const newNickname = dom.nicknameInput.value;
        const nicknameKey = state.myRealAddress || state.myPublisherId;
        if (newNickname) {
            state.myNickname = newNickname;
            sessionStorage.setItem(`nickname_${nicknameKey}`, state.myNickname);
            state.userNicknames.set(nicknameKey, state.myNickname);
            dom.userIdDisplay.textContent = state.myNickname;
        }
        state.isGhostMode = dom.ghostModeCheckbox.checked;
        sessionStorage.setItem(`ghostMode_${state.myPublisherId}`, state.isGhostMode);
        if (state.isGhostMode) state.activeUsers.delete(state.myPublisherId); else streamr.publishPresence();
        ui.updateUserList(state.activeUsers, state.verifiedRealAddresses, utils.getDisplayName, utils.getUserColor);
        dom.nicknameModal.classList.add('hidden');
    });

    dom.resetNicknameBtn.addEventListener('click', () => {
        const nicknameKey = state.myRealAddress || state.myPublisherId;
        state.myNickname = '';
        sessionStorage.removeItem(`nickname_${nicknameKey}`);
        state.userNicknames.delete(nicknameKey);
        dom.userIdDisplay.textContent = state.myRealAddress || state.myPublisherId;
        state.isGhostMode = false; dom.ghostModeCheckbox.checked = false;
        sessionStorage.removeItem(`ghostMode_${state.myPublisherId}`);
        streamr.publishPresence();
        dom.nicknameModal.classList.add('hidden');
        dom.nicknameInput.value = '';
    });

    dom.nicknameModal.addEventListener('click', (e) => { if (e.target === dom.nicknameModal) dom.nicknameModal.classList.add('hidden'); });
    dom.cancelReplyBtn.addEventListener('click', () => { state.replyingTo = null; dom.replyingToContainer.classList.add('hidden'); });
    dom.closeAlertBtn.addEventListener('click', () => dom.customAlertModal.classList.add('hidden'));
    dom.customAlertModal.addEventListener('click', (e) => { if (e.target === dom.customAlertModal) dom.customAlertModal.classList.add('hidden'); });

    // --- Room UI Listeners ---
    document.getElementById('privateRoomInfoBtn').addEventListener('click', () => ui.showCustomAlert('Private Room Security', 'All communication is end-to-end encrypted using a key derived from the password with PBKDF2 and AES-GCM.'));
    document.getElementById('pfsRoomInfoBtn').addEventListener('click', () => ui.showCustomAlert('High-Security (Ephemeral) Mode', 'Provides Perfect Forward Secrecy (PFS) using Elliptic-curve Diffie-Hellman (ECDH) to generate unique session keys for every session.'));
    dom.roomsBtn.addEventListener('click', () => dom.roomSelectionModal.classList.remove('hidden'));
    dom.closeRoomModalBtn.addEventListener('click', () => dom.roomSelectionModal.classList.add('hidden'));
    dom.roomSelectionModal.addEventListener('click', (e) => { if (e.target === dom.roomSelectionModal) dom.roomSelectionModal.classList.add('hidden'); });

    function updateRoomCreationModal() {
        const isPFS = dom.pfsRoomCheckbox.checked;
        const roomType = document.querySelector('input[name="roomType"]:checked').value;
        
        dom.privateRoomCheckbox.disabled = isPFS;
        if (isPFS) dom.privateRoomCheckbox.checked = true;
        
        // Hide security options for streamer rooms as they are public by nature
        dom.securityOptionsContainer.classList.toggle('hidden', roomType === 'streamer');

        dom.passwordContainer.classList.toggle('hidden', !dom.privateRoomCheckbox.checked || roomType === 'streamer');
    }
    dom.privateRoomCheckbox.addEventListener('change', updateRoomCreationModal);
    dom.pfsRoomCheckbox.addEventListener('change', updateRoomCreationModal);
    document.querySelectorAll('input[name="roomType"]').forEach(radio => {
        radio.addEventListener('change', updateRoomCreationModal);
    });


    dom.createRoomBtn.addEventListener('click', async () => {
        const newRoomName = dom.newRoomInput.value.trim();
        if (!newRoomName) return;
    
        const roomType = document.querySelector('input[name="roomType"]:checked').value;
        const isPrivate = roomType !== 'streamer' && dom.privateRoomCheckbox.checked;
        const isPFS = roomType !== 'streamer' && dom.pfsRoomCheckbox.checked;
    
        if (isPrivate) {
            const password = dom.roomPasswordInput.value;
            if (!password) { ui.showCustomAlert('Password Required', 'Please enter a password.'); return; }
            state.roomPasswords.set(newRoomName, password);
        }
    
        const roomSettings = { isPFS, roomType };
        state.roomSettings.set(newRoomName, roomSettings);
    
        await streamr.switchRoom(newRoomName);
    
        if (roomType === 'streamer' && state.myPublisherId) {
             // Automatically trigger the go live flow for the creator
            dom.streamSettingsModal.classList.remove('hidden');
        }
    
        // Reset and close modal
        dom.newRoomInput.value = '';
        dom.roomPasswordInput.value = '';
        dom.privateRoomCheckbox.checked = false;
        dom.pfsRoomCheckbox.checked = false;
        document.querySelector('input[name="roomType"][value="chat"]').checked = true;
        updateRoomCreationModal();
        dom.roomSelectionModal.classList.add('hidden');
    });

    dom.newRoomInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') dom.createRoomBtn.click(); });

    dom.roomList.addEventListener('click', async (e) => {
        const joinBtn = e.target.closest('.join-room-btn');
        if (joinBtn) {
            const roomId = joinBtn.dataset.roomId;
            if ((joinBtn.dataset.isPrivate === 'true') && !state.roomPasswords.has(roomId)) {
                const password = prompt(`Enter password for room "${roomId}":`);
                if (password) state.roomPasswords.set(roomId, password); else return;
            }
            if (roomId) { await streamr.switchRoom(roomId); dom.roomSelectionModal.classList.add('hidden'); }
        }
    });

    document.addEventListener('click', (e) => {
        for (const streamInfo of state.remoteStreams.values()) {
            if (streamInfo.audioContext && streamInfo.audioContext.state === 'suspended') streamInfo.audioContext.resume();
        }
        const picker = document.getElementById('reactionPicker');
        if (picker && picker.style.display === 'flex' && !picker.contains(e.target) && !e.target.closest('.message-actions')) picker.style.display = 'none';
        if (!dom.onlineHeader.parentElement.contains(e.target) && !dom.usersList.classList.contains('hidden')) { dom.usersList.classList.add('hidden'); dom.onlineHeader.querySelector('svg').classList.remove('rotate-180'); }
        if (!dom.emojiBtn.contains(e.target) && !dom.emojiPicker.contains(e.target)) dom.emojiPicker.classList.add('hidden');
        if (!dom.attachBtn.contains(e.target) && !dom.attachMenu.contains(e.target)) dom.attachMenu.classList.add('hidden');
    });

    document.body.addEventListener('click', (e) => {
        const picker = document.getElementById('reactionPicker');
        if (picker && e.target.parentElement === picker) {
            streamr.sendReaction(picker.dataset.messageId, e.target.dataset.emoji);
            picker.style.display = 'none';
        }
    });

    dom.connectWalletBtn.addEventListener('click', async () => {
        try { await streamr.connectWithWallet(); } catch (err) { sessionStorage.removeItem('authMethod'); ui.setLoginModalState('buttons'); }
    });

    dom.guestBtn.addEventListener('click', async () => {
        sessionStorage.removeItem('authMethod');
        state.myRealAddress = '';
        try { await streamr.initializeChat(); } catch (err) { ui.setLoginModalState('buttons'); }
    });

    dom.walletBtn.addEventListener('click', () => {
        if (sessionStorage.getItem('authMethod') === 'metamask') streamr.disconnectWallet();
        else dom.connectWalletBtn.click();
    });

    // ADDED: Event listener for the new rekey button
    dom.rekeyBtn.addEventListener('click', () => {
        streamr.requestRekey();
        ui.showCustomAlert('Request Sent', 'A request for a new session key has been sent to the room leader.');
    });
}

function startReply(messageId) {
    const message = state.lastMessages.find(m => (m.id || m.timestamp) == messageId);
    if (message) {
        state.replyingTo = message;
        let contentSnippet = message.type === 'text' ? message.content : (message.type === 'image' ? 'Image' : `File: ${message.metadata.fileName}`);
        dom.replyingToUser.innerHTML = `Replying to <span style="color: ${utils.getUserColor(message.userId)};">${utils.getDisplayName(message.userId)}</span>`;
        dom.replyingToText.textContent = contentSnippet;
        dom.replyingToContainer.classList.remove('hidden');
        dom.messageInput.focus();
    }
}


// --- INITIALIZATION LOGIC ---
async function handlePageLoad() {
    await db.initDB();
    workers.setupFileWorker();
    setupEventListeners();
    const preferredAuth = sessionStorage.getItem('authMethod');

    if (preferredAuth === 'metamask') {
        try {
            await streamr.connectWithWallet();
        } catch (err) {
            sessionStorage.removeItem('authMethod');
            ui.setLoginModalState('buttons');
        }
    } else {
        ui.setLoginModalState('buttons');
    }
}

window.addEventListener('load', handlePageLoad);


