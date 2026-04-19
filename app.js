(() => {
  const fileInput = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const selectedFileEl = document.getElementById("selectedFile");
  const convertBtn = document.getElementById("convertBtn");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const statusEl = document.getElementById("status");

  let selectedFile = null;
  let isConverting = false;

  function setStatus(text, mode = "") {
    statusEl.textContent = text;
    statusEl.classList.remove("error", "ok");
    if (mode) {
      statusEl.classList.add(mode);
    }
  }

  function safeNameWithoutExt(name) {
    const lastDot = name.lastIndexOf(".");
    const stem = (lastDot > 0 ? name.slice(0, lastDot) : name).trim();
    const cleaned = stem
      .normalize("NFC")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .trim();
    return cleaned || "converted_audio";
  }

  function encodePcm16Wav(floatSamples, sampleRate, channels = 1) {
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = floatSamples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < floatSamples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return buffer;
  }

  async function convertViaWebAudio(file) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !window.OfflineAudioContext) {
      throw new Error("WebAudio conversion is not supported in this browser");
    }

    progressBar.value = 10;
    progressText.textContent = "10%";

    const inputData = await file.arrayBuffer();
    const audioCtx = new AudioCtx();
    const decodedBuffer = await audioCtx.decodeAudioData(inputData.slice(0));
    await audioCtx.close();

    progressBar.value = 45;
    progressText.textContent = "45%";

    const targetRate = 8000;
    const targetLength = Math.max(1, Math.ceil(decodedBuffer.duration * targetRate));
    const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();

    progressBar.value = 85;
    progressText.textContent = "85%";

    const mono = rendered.getChannelData(0);
    const wav = encodePcm16Wav(mono, targetRate, 1);
    return new Blob([wav], { type: "audio/wav" });
  }

  function triggerDownload(blob, originalName) {
    const stem = safeNameWithoutExt(originalName);
    const downloadName = `${stem}_converted.wav`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return downloadName;
  }

  function setFile(file) {
    selectedFile = file;
    selectedFileEl.textContent = file ? `Selected: ${file.name}` : "No file selected";
    convertBtn.disabled = !(file && !isConverting);
  }

  async function convert() {
    if (!selectedFile || isConverting) {
      return;
    }

    isConverting = true;
    convertBtn.disabled = true;
    progressBar.value = 0;
    progressText.textContent = "0%";
    setStatus("Converting...", "");

    try {
      const blob = await convertViaWebAudio(selectedFile);
      const downloadName = triggerDownload(blob, selectedFile.name);
      progressBar.value = 100;
      progressText.textContent = "100%";
      setStatus(`Done. Download started: ${downloadName}`, "ok");
    } catch (err) {
      console.error(err);
      setStatus("Conversion failed. Try another file.", "error");
    } finally {
      isConverting = false;
      convertBtn.disabled = !selectedFile;
    }
  }

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0] || null;
    setFile(file);
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0] || null;
    if (file) {
      fileInput.files = e.dataTransfer.files;
      setFile(file);
    }
  });

  convertBtn.addEventListener("click", convert);

  setStatus("Ready.", "ok");
})();
