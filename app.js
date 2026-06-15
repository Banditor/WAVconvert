(() => {
  const fileInput = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const selectedFileEl = document.getElementById("selectedFile");
  const convertBtn = document.getElementById("convertBtn");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const statusEl = document.getElementById("status");
  const latestDownloadBtn = document.getElementById("latestDownloadBtn");
  const storageConfig = window.WAV_STORAGE_CONFIG || {};
  const latestMirrorPath = "./latest/latest.wav";

  let selectedFile = null;
  let isConverting = false;
  let isDownloadingLatest = false;

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

  function getStorageObjectUrl() {
    const baseUrl = String(storageConfig.supabaseUrl || "").replace(/\/+$/, "");
    const bucket = encodeURIComponent(storageConfig.bucket || "");
    const objectPath = String(storageConfig.objectPath || "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    if (
      !baseUrl ||
      !bucket ||
      !objectPath ||
      !storageConfig.supabasePublishableKey
    ) {
      return "";
    }

    return `${baseUrl}/storage/v1/object/${bucket}/${objectPath}`;
  }

  function getStorageHeaders(extraHeaders = {}) {
    return {
      apikey: storageConfig.supabasePublishableKey,
      Authorization: `Bearer ${storageConfig.supabasePublishableKey}`,
      ...extraHeaders,
    };
  }

  async function saveLatestConversion(blob) {
    const objectUrl = getStorageObjectUrl();
    if (!objectUrl) {
      throw new Error("Cloud storage is not configured");
    }

    const response = await fetch(objectUrl, {
      method: "POST",
      headers: getStorageHeaders({
        "Content-Type": "audio/wav",
        "Cache-Control": "no-cache",
        "x-upsert": "true",
      }),
      body: blob,
    });

    if (!response.ok) {
      throw new Error(`Cloud upload failed with status ${response.status}`);
    }
  }

  async function downloadLatestConversion() {
    if (isDownloadingLatest) {
      return;
    }

    isDownloadingLatest = true;
    latestDownloadBtn.disabled = true;
    setStatus("Downloading the latest converted file...");

    try {
      const response = await fetch(`${latestMirrorPath}?v=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("No converted file has been saved yet");
        }
        throw new Error(`Latest download failed with status ${response.status}`);
      }

      const blob = await response.blob();
      const downloadName = triggerDownload(blob, "latest.wav");
      setStatus(`Latest file downloaded: ${downloadName}`, "ok");
    } catch (err) {
      console.error(err);
      const message =
        err.message === "No converted file has been saved yet"
          ? err.message
          : "Could not download the latest converted file.";
      setStatus(message, "error");
    } finally {
      isDownloadingLatest = false;
      latestDownloadBtn.disabled = false;
    }
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
      progressBar.value = 92;
      progressText.textContent = "92%";
      setStatus(`Download started: ${downloadName}. Saving the latest copy...`);

      try {
        await saveLatestConversion(blob);
        progressBar.value = 100;
        progressText.textContent = "100%";
        setStatus(
          `Done. Latest copy saved: ${downloadName}. Button 0 updates within a few minutes.`,
          "ok",
        );
      } catch (storageError) {
        console.error(storageError);
        progressBar.value = 100;
        progressText.textContent = "100%";
        setStatus(
          `Download started: ${downloadName}. Cloud copy could not be updated.`,
          "error",
        );
      }
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

  fileInput.addEventListener("click", () => {
    fileInput.value = "";
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
      setFile(file);
    }
  });

  convertBtn.addEventListener("click", convert);
  latestDownloadBtn.addEventListener("click", downloadLatestConversion);

  setStatus("Ready.", "ok");
})();
