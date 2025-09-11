// cryptoUtils.js

// TextEncoder/Decoder instances are used frequently for crypto operations
export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

// Helper functions for data conversion
export function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export function base64ToArrayBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// Derives a cryptographic key from a password and a salt (roomId)
export async function deriveKeyFromPassword(password, salt) {
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        textEncoder.encode(password),
        {name: 'PBKDF2'},
        false,
        ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
        {
            "name": 'PBKDF2',
            "salt": textEncoder.encode(salt),
            "iterations": 310000,
            "hash": 'SHA-256'
        },
        keyMaterial,
        {"name": 'AES-GCM', "length": 256},
        false,
        ["encrypt", "decrypt"]
    );
}

// Encrypts a data buffer using a derived key
export async function encryptMessage(data, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // Initialization Vector
    const encryptedContent = await window.crypto.subtle.encrypt(
        {name: 'AES-GCM', iv: iv},
        key,
        data
    );
    // Return IV and encrypted data as base64 strings for easy transport
    return {
        iv: arrayBufferToBase64(iv),
        content: arrayBufferToBase64(encryptedContent)
    };
}

// Decrypts a base64 encoded string using a derived key and IV
export async function decryptMessage(encryptedBase64, key, ivBase64) {
    try {
        const iv = base64ToArrayBuffer(ivBase64);
        const encryptedData = base64ToArrayBuffer(encryptedBase64);
        return await window.crypto.subtle.decrypt(
            {name: 'AES-GCM', iv: iv},
            key,
            encryptedData
        );
    } catch (e) {
        console.error("Decryption failed:", e);
        return null; // Indicates a failure, likely due to a wrong key
    }
}

// --- PFS (Perfect Forward Secrecy) Functions ---

export async function generatePFSKeyPair() {
    return await window.crypto.subtle.generateKey(
        {name: 'ECDH', namedCurve: 'P-256'},
        false, // The private key is NOT exportable, increasing security.
        ['deriveKey']
    );
}

export async function exportPublicKey(key) {
    return await window.crypto.subtle.exportKey('jwk', key);
}

export async function importPublicKey(jwk) {
    return await window.crypto.subtle.importKey(
        'jwk',
        jwk,
        {name: 'ECDH', namedCurve: 'P-256'},
        true,
        []
    );
}
