# P2P Decentralized Chat

This is a real-time, peer-to-peer (P2P) chat application built on the Streamr Network. It provides a secure, censorship-resistant, and serverless communication platform, where users connect directly to each other to exchange messages, files, and live streams.

## Key Features

* **Decentralized Communication:** Uses the Streamr Network to enable direct P2P messaging without a central server.
* **Secure Identity:** Users can connect their Ethereum-compatible wallet for a persistent identity or join as a guest with a temporary session.
* **Public & Private Rooms:** Join a public `Lobby` or create a password-protected private room with end-to-end encryption (AES-GCM).
* **High-Security (PFS) Mode:** Private rooms can be configured with Perfect Forward Secrecy (PFS) using Elliptic-curve Diffie-Hellman (ECDH) to generate ephemeral, per-session encryption keys.
* **P2P File Transfer:** Send images, videos, and other files. Files are broken into chunks, hashed, and distributed in a P2P fashion, with automatic seeding to other users who want to download them.
* **Live Video/Audio Streaming:** Start a live video stream from your camera, which is compressed and sent to the room in real-time.
* **Real-time Features:** Includes typing indicators, message reactions, and a live list of active users.
* **UI/UX:** A clean, responsive, and easy-to-use interface that adapts to different screen sizes.
* **No Central Server:** The application is a self-contained web app that can be hosted anywhere, ensuring resilience and eliminating a single point of failure.

## Technologies Used

* **Streamr SDK:** The core library for pub/sub communication on the Streamr Network.
* **Ethers.js:** For seamless wallet connection and identity verification.
* **Web Workers:** Offloads heavy tasks like file hashing and video frame encoding to background threads.
* **Web Crypto API:** Handles all cryptographic operations for encryption, decryption, and key derivation.
* **IndexedDB:** Provides local, client-side storage for managing file pieces during P2P transfers.
* **HTML, CSS, JavaScript (ES6+):** The foundation of the web application.

## How to Run

1.  Clone this repository or download the source files.
2.  Open `index.html` in any modern web browser.

No installation or server setup is required.

## Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request for any new features, bug fixes, or improvements.

## License

This project is licensed under the MIT License.
