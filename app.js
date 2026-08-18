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
  const latestMetadataPath = "./latest/metadata.json";
  const localLatestDbName = "wav-converter-latest";
  const localLatestStoreName = "latest";
  const localLatestRecordKey = "current";

  let selectedFile = null;
  let isConverting = false;
  let isDownloadingLatest = false;
  let latestLocalConversion = null;
  let localLatestLoaded = false;

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

  function safeDownloadName(name) {
    const cleaned = String(name || "")
      .normalize("NFC")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^\.+|\.+$/g, "")
      .trim();
    const withExtension = /\.wav$/i.test(cleaned) ? cleaned : `${cleaned}.wav`;
    return cleaned ? withExtension : "latest_converted.wav";
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

  function triggerNamedDownload(blob, name) {
    const downloadName = safeDownloadName(name);
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

  function triggerDownload(blob, originalName) {
    const stem = safeNameWithoutExt(originalName);
    return triggerNamedDownload(blob, `${stem}_converted.wav`);
  }

  function openLocalLatestDb() {
    if (!window.indexedDB) {
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(localLatestDbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(localLatestStoreName)) {
          db.createObjectStore(localLatestStoreName);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        reject(request.error || new Error("Could not open local latest cache"));
      };
      request.onblocked = () => {
        reject(new Error("Local latest cache is blocked"));
      };
    });
  }

  async function readLocalLatestConversion() {
    if (latestLocalConversion) {
      return latestLocalConversion;
    }

    if (localLatestLoaded) {
      return null;
    }

    localLatestLoaded = true;

    try {
      const db = await openLocalLatestDb();
      if (!db) {
        return null;
      }

      try {
        const record = await new Promise((resolve, reject) => {
          const transaction = db.transaction(localLatestStoreName, "readonly");
          const request = transaction
            .objectStore(localLatestStoreName)
            .get(localLatestRecordKey);

          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => {
            reject(request.error || new Error("Could not read local latest"));
          };
        });

        if (!(record?.blob instanceof Blob)) {
          return null;
        }

        latestLocalConversion = {
          blob: record.blob,
          downloadName: safeDownloadName(record.downloadName),
          savedAt: Number(record.savedAt) || 0,
          source: "persisted",
        };

        return latestLocalConversion;
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn("Local latest copy is unavailable.", err);
      return null;
    }
  }

  async function saveLocalLatestConversion(blob, downloadName, savedAt) {
    const record = {
      blob,
      downloadName: safeDownloadName(downloadName),
      savedAt,
    };

    latestLocalConversion = record;
    latestLocalConversion.source = "current-page";
    localLatestLoaded = true;

    try {
      const db = await openLocalLatestDb();
      if (!db) {
        return record;
      }

      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(localLatestStoreName, "readwrite");
          transaction
            .objectStore(localLatestStoreName)
            .put(record, localLatestRecordKey);

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => {
            reject(transaction.error || new Error("Could not save local latest"));
          };
          transaction.onabort = () => {
            reject(transaction.error || new Error("Local latest save aborted"));
          };
        });
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn("Could not persist the local latest copy.", err);
    }

    return record;
  }

  function shouldUseLocalLatest(localLatest, latestMetadata) {
    if (!localLatest) {
      return false;
    }

    if (latestMetadata.savedAt > 0) {
      return localLatest.savedAt >= latestMetadata.savedAt;
    }

    return localLatest.source === "current-page";
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

  function getStorageObjectInfoUrl() {
    const objectUrl = getStorageObjectUrl();
    return objectUrl
      ? objectUrl.replace("/storage/v1/object/", "/storage/v1/object/info/")
      : "";
  }

  function getStorageHeaders(extraHeaders = {}) {
    return {
      apikey: storageConfig.supabasePublishableKey,
      Authorization: `Bearer ${storageConfig.supabasePublishableKey}`,
      ...extraHeaders,
    };
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    if (!window.AbortController) {
      return fetch(url, options);
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function readStorageError(response) {
    const text = await response.text().catch(() => "");
    if (!text) {
      return `HTTP ${response.status}`;
    }

    try {
      const error = JSON.parse(text);
      return error.message || error.error || text;
    } catch (_err) {
      return text;
    }
  }

  async function uploadLatestConversion(blob, downloadName, savedAt, method) {
    const objectUrl = getStorageObjectUrl();
    if (!objectUrl) {
      throw new Error("Cloud storage is not configured");
    }

    const formData = new FormData();
    formData.append("cacheControl", "0");
    formData.append(
      "metadata",
      JSON.stringify({
        downloadName: safeDownloadName(downloadName),
        savedAt,
      }),
    );
    formData.append("", blob, storageConfig.objectPath || "latest.wav");

    const response = await fetch(objectUrl, {
      method,
      headers: getStorageHeaders({
        ...(method === "POST" ? { "x-upsert": "true" } : {}),
      }),
      body: formData,
    });

    if (!response.ok) {
      const errorText = await readStorageError(response);
      throw new Error(`${method} failed: ${errorText}`);
    }
  }

  async function saveLatestConversion(blob, downloadName, savedAt) {
    const errors = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const method of ["POST", "PUT"]) {
        try {
          await uploadLatestConversion(blob, downloadName, savedAt, method);
          return;
        } catch (err) {
          errors.push(err.message || String(err));
        }
      }

      if (attempt < 2) {
        await wait(500 * (attempt + 1));
      }
    }

    throw new Error(
      `Cloud upload failed after retries: ${errors[errors.length - 1]}`,
    );
  }

  async function getLatestMetadata(cacheBuster) {
    try {
      const response = await fetch(
        `${latestMetadataPath}?v=${cacheBuster}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );

      if (!response.ok) {
        return {
          downloadName: "latest_converted.wav",
          savedAt: 0,
        };
      }

      const metadata = await response.json();
      return {
        downloadName: safeDownloadName(metadata.downloadName),
        savedAt: Number(metadata.savedAt) || 0,
      };
    } catch (err) {
      console.warn("Latest filename metadata is unavailable.", err);
      return {
        downloadName: "latest_converted.wav",
        savedAt: 0,
      };
    }
  }

  async function getCloudLatestMetadata(cacheBuster) {
    const infoUrl = getStorageObjectInfoUrl();
    if (!infoUrl) {
      return null;
    }

    try {
      const response = await fetchWithTimeout(
        `${infoUrl}?v=${cacheBuster}`,
        {
          method: "GET",
          headers: getStorageHeaders(),
          cache: "no-store",
        },
        3000,
      );

      if (!response.ok) {
        return null;
      }

      const info = await response.json();
      return {
        downloadName: safeDownloadName(info.metadata?.downloadName),
        savedAt: Number(info.metadata?.savedAt) || 0,
      };
    } catch (err) {
      console.warn("Cloud latest metadata is unavailable.", err);
      return null;
    }
  }

  async function getCloudLatestBlob(cacheBuster) {
    const objectUrl = getStorageObjectUrl();
    if (!objectUrl) {
      throw new Error("Cloud storage is not configured");
    }

    const response = await fetchWithTimeout(
      `${objectUrl}?download=${cacheBuster}`,
      {
        method: "GET",
        headers: getStorageHeaders(),
        cache: "no-store",
      },
      12000,
    );

    if (!response.ok) {
      throw new Error(`Cloud latest download failed with status ${response.status}`);
    }

    return response.blob();
  }

  async function downloadLatestConversion() {
    if (isDownloadingLatest) {
      return;
    }

    isDownloadingLatest = true;
    latestDownloadBtn.disabled = true;
    setStatus("Downloading the latest converted file...");

    try {
      const cacheBuster = Date.now();
      const [localLatest, latestMetadata, cloudMetadata] = await Promise.all([
        readLocalLatestConversion(),
        getLatestMetadata(cacheBuster),
        getCloudLatestMetadata(cacheBuster),
      ]);
      const newestKnownMetadata =
        cloudMetadata && cloudMetadata.savedAt > latestMetadata.savedAt
          ? cloudMetadata
          : latestMetadata;

      if (shouldUseLocalLatest(localLatest, newestKnownMetadata)) {
        const savedName = triggerNamedDownload(
          localLatest.blob,
          localLatest.downloadName,
        );
        setStatus(`Latest file downloaded: ${savedName}`, "ok");
        return;
      }

      if (cloudMetadata && cloudMetadata.savedAt > latestMetadata.savedAt) {
        try {
          const blob = await getCloudLatestBlob(cacheBuster);
          const savedName = triggerNamedDownload(blob, cloudMetadata.downloadName);
          setStatus(`Latest file downloaded: ${savedName}`, "ok");
          return;
        } catch (cloudDownloadError) {
          console.warn("Cloud latest copy is newer but unreachable.", cloudDownloadError);
          throw new Error("Latest GitHub copy is still updating");
        }
      }

      const response = await fetch(`${latestMirrorPath}?v=${cacheBuster}`, {
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
      const savedName = triggerNamedDownload(blob, latestMetadata.downloadName);
      setStatus(`Latest file downloaded: ${savedName}`, "ok");
    } catch (err) {
      console.error(err);
      const message =
        err.message === "No converted file has been saved yet"
          ? err.message
          : err.message === "Latest GitHub copy is still updating"
            ? "The latest file is saved, but GitHub is still updating. Try again in a few minutes."
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
      const savedAt = Date.now();
      const downloadName = triggerDownload(blob, selectedFile.name);
      await saveLocalLatestConversion(blob, downloadName, savedAt);
      progressBar.value = 92;
      progressText.textContent = "92%";
      setStatus(
        `Download started: ${downloadName}. Button 0 is ready now. Saving the cloud copy...`,
      );

      try {
        await saveLatestConversion(blob, downloadName, savedAt);
        progressBar.value = 100;
        progressText.textContent = "100%";
        setStatus(
          `Done. Latest copy saved: ${downloadName}. Button 0 is ready now.`,
          "ok",
        );
      } catch (storageError) {
        console.error(storageError);
        progressBar.value = 100;
        progressText.textContent = "100%";
        setStatus(
          `Download started: ${downloadName}. Button 0 is ready now, but the cloud copy could not be updated.`,
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
