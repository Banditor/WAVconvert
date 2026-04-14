(() => {
  const { FFmpeg } = FFmpegWASM;
  const { fetchFile } = FFmpegUtil;

  const fileInput = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const selectedFileEl = document.getElementById("selectedFile");
  const convertBtn = document.getElementById("convertBtn");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const statusEl = document.getElementById("status");

  const ffmpeg = new FFmpeg();
  let selectedFile = null;
  let isReady = false;
  let isConverting = false;
  let useWebAudioFallback = false;

  function setStatus(text, mode = "") {
    statusEl.textContent = text;
    statusEl.classList.remove("error", "ok");
    if (mode) {
      statusEl.classList.add(mode);
    }
  }

  function safeNameWithoutExt(name) {
    const lastDot = name.lastIndexOf(".");
    return (lastDot > 0 ? name.slice(0, lastDot) : name).replace(/[^a-zA-Z0-9_-]/g, "_");
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

    const inputData = await file.arrayBuffer();
    const audioCtx = new AudioCtx();
    const decodedBuffer = await audioCtx.decodeAudioData(inputData.slice(0));
    await audioCtx.close();

    const targetRate = 8000;
    const targetLength = Math.max(1, Math.ceil(decodedBuffer.duration * targetRate));
    const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
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
    convertBtn.disabled = !(file && isReady && !isConverting);
  }

  async function init() {
    try {
      const loadSources = [
        "./vendor/ffmpeg",
        "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd",
        "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
      ];

      ffmpeg.on("progress", ({ progress }) => {
        const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
        progressBar.value = pct;
        progressText.textContent = `${pct}%`;
      });

      let loaded = false;
      let lastErr = null;

      for (let i = 0; i < loadSources.length && !loaded; i += 1) {
        const baseURL = loadSources[i];
        const bust = `v=${Date.now()}_${i}`;
        setStatus(`Loading converter core... (attempt ${i + 1}/${loadSources.length})`);
        try {
          const loadPromise = ffmpeg.load({
            coreURL: `${baseURL}/ffmpeg-core.js?${bust}`,
            wasmURL: `${baseURL}/ffmpeg-core.wasm?${bust}`
          });
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("FFmpeg core load timeout")), 180000);
          });
          await Promise.race([loadPromise, timeoutPromise]);
          loaded = true;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!loaded) {
        throw lastErr || new Error("Unable to load ffmpeg core");
      }

      isReady = true;
      setStatus("Converter is ready.", "ok");
      convertBtn.disabled = !selectedFile;
    } catch (err) {
      console.error(err);
      useWebAudioFallback = true;
      isReady = true;
      convertBtn.disabled = !selectedFile;
      setStatus("FFmpeg load failed. Using browser fallback mode.", "ok");
    }
  }

  async function convert() {
    if (!selectedFile || !isReady || isConverting) {
      return;
    }

    isConverting = true;
    convertBtn.disabled = true;
    progressBar.value = 0;
    progressText.textContent = "0%";
    setStatus("Converting...");

    const inputName = `input_${Date.now()}`;
    const outputName = "output_converted.wav";

    try {
      let blob;
      if (useWebAudioFallback) {
        blob = await convertViaWebAudio(selectedFile);
      } else {
        await ffmpeg.writeFile(inputName, await fetchFile(selectedFile));
        await ffmpeg.exec([
          "-i", inputName,
          "-ac", "1",
          "-ar", "8000",
          "-acodec", "pcm_s16le",
          outputName
        ]);
        const outData = await ffmpeg.readFile(outputName);
        blob = new Blob([outData.buffer], { type: "audio/wav" });
      }

      const downloadName = triggerDownload(blob, selectedFile.name);

      setStatus(`Done. Download started: ${downloadName}`, "ok");
      progressBar.value = 100;
      progressText.textContent = "100%";
      if (!useWebAudioFallback) {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      }
    } catch (err) {
      console.error(err);
      if (!useWebAudioFallback) {
        try {
          setStatus("FFmpeg failed, trying browser fallback...");
          const blob = await convertViaWebAudio(selectedFile);
          const downloadName = triggerDownload(blob, selectedFile.name);
          useWebAudioFallback = true;
          setStatus(`Done (fallback). Download started: ${downloadName}`, "ok");
          progressBar.value = 100;
          progressText.textContent = "100%";
          return;
        } catch (fallbackErr) {
          console.error(fallbackErr);
        }
      }
      setStatus("Conversion failed. Try another file.", "error");
    } finally {
      isConverting = false;
      convertBtn.disabled = !(selectedFile && isReady);
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

  init();
})();
