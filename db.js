// db.js

import { state } from './state.js';

export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('FilePiecesDB', 1);
        request.onupgradeneeded = (event) => {
            const dbInstance = event.target.result;
            dbInstance.createObjectStore('pieces', { keyPath: ['fileId', 'pieceIndex'] });
        };
        request.onsuccess = (event) => {
            state.db = event.target.result;
            resolve();
        };
        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.errorCode);
            reject(event.target.errorCode);
        };
    });
}

export function savePiece(fileId, pieceIndex, data) {
    return new Promise((resolve, reject) => {
        if (!state.db) {
            return reject("Database not initialized.");
        }
        const transaction = state.db.transaction(['pieces'], 'readwrite');
        const store = transaction.objectStore('pieces');
        const request = store.put({ fileId, pieceIndex, data });
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}

export function getAllPiecesAsFile(fileId, fileName, fileType) {
    return new Promise((resolve, reject) => {
        if (!state.db) {
            return reject("Database not initialized.");
        }
        const transaction = state.db.transaction(['pieces'], 'readonly');
        const store = transaction.objectStore('pieces');
        const range = IDBKeyRange.bound([fileId, 0], [fileId, Infinity]);
        const request = store.getAll(range);

        request.onsuccess = (event) => {
            const piecesData = event.target.result.map(p => p.data);
            const blob = new Blob(piecesData, { type: fileType });
            const file = new File([blob], fileName, { type: fileType });
            resolve(file);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

export function clearFile(fileId) {
    return new Promise((resolve, reject) => {
        if (!state.db) {
            return reject("Database not initialized.");
        }
        const transaction = state.db.transaction(['pieces'], 'readwrite');
        const store = transaction.objectStore('pieces');
        const range = IDBKeyRange.bound([fileId, 0], [fileId, Infinity]);
        const request = store.delete(range);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}