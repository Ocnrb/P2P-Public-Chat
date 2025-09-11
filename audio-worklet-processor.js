// audio-worklet-processor.js

// --- Parâmetros de Configuração ---
const BUFFER_SIZE_SECONDS = 0.5; // Meio segundo de buffer para absorver o jitter da rede
const MAX_BUFFERED_CHUNKS = 50;  // Previne que a latência cresça indefinidamente

/**
 * PlayerProcessor
 * Recebe áudio da rede (através da thread principal), armazena-o num buffer e reprodu-lo de forma contínua.
 * Isto resolve os problemas de gaguez e latência acumulada.
 */
class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // O tamanho do buffer é calculado com base na sample rate para maior precisão.
    this.bufferSize = Math.floor(BUFFER_SIZE_SECONDS * sampleRate);
    this.ringBuffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.isBuffering = true; // Começa em modo de buffering para garantir uma reprodução inicial suave.

    // Fila para os pedaços de áudio recebidos da thread principal.
    this.chunksQueue = [];

    // Lida com as mensagens (pedaços de áudio) vindas da thread principal.
    this.port.onmessage = (event) => {
      this.chunksQueue.push(event.data);
      // Para prevenir o crescimento ilimitado do buffer e da latência, descarta pedaços antigos.
      if (this.chunksQueue.length > MAX_BUFFERED_CHUNKS) {
        this.chunksQueue.shift();
      }
    };
  }

  // Verifica a quantidade de dados disponíveis no buffer.
  get availableData() {
    if (this.writeIndex >= this.readIndex) {
      return this.writeIndex - this.readIndex;
    }
    return this.bufferSize - this.readIndex + this.writeIndex;
  }

  // Adiciona dados ao buffer circular.
  addToBuffer(data) {
    for (let i = 0; i < data.length; i++) {
      this.ringBuffer[this.writeIndex] = data[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outputChannel = output[0];
    const frameCount = outputChannel.length;

    // Move os pedaços da fila para o buffer circular.
    while (this.chunksQueue.length > 0) {
      const chunk = this.chunksQueue.shift();
      this.addToBuffer(chunk);
    }
    
    // Se estivermos em modo de buffering, esperamos até ter dados suficientes.
    if (this.isBuffering && this.availableData >= frameCount) {
        this.isBuffering = false;
    }

    // Se não estivermos a fazer buffering e tivermos dados suficientes, reproduzimos.
    if (!this.isBuffering && this.availableData >= frameCount) {
      for (let i = 0; i < frameCount; i++) {
        outputChannel[i] = this.ringBuffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.bufferSize;
      }
    } else {
      // Se não houver dados suficientes, preenchemos com silêncio para evitar ruído.
      // E voltamos ao modo de buffering.
      this.isBuffering = true;
      for (let i = 0; i < frameCount; i++) {
        outputChannel[i] = 0;
      }
    }

    return true;
  }
}

// Regista o processador para que o AudioContext o possa encontrar.
registerProcessor('player-processor', PlayerProcessor);
