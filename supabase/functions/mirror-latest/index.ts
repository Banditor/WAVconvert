const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sourceSupabaseUrl =
  Deno.env.get("LATEST_SOURCE_SUPABASE_URL") ||
  "https://gogkesmxlfkzjkldmpke.supabase.co";
const sourceSupabaseKey =
  Deno.env.get("LATEST_SOURCE_SUPABASE_KEY") ||
  "sb_publishable_bRVpK3E-3OXkAi-IMWvzeA_NELsAN0i";
const githubToken = Deno.env.get("GITHUB_TOKEN") || "";
const githubRepo = Deno.env.get("GITHUB_REPO") || "Banditor/WAVconvert";
const githubBranch = Deno.env.get("GITHUB_BRANCH") || "main";
const storageBucket = Deno.env.get("LATEST_STORAGE_BUCKET") ||
  "latest-conversions";
const storageObjectPath = Deno.env.get("LATEST_STORAGE_OBJECT") || "latest.wav";
const metadataRepoPath = "latest/metadata.json";
const audioRepoPath = "latest/latest.wav";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function safeDownloadName(name: unknown) {
  const cleaned = String(name || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const withExtension = /\.wav$/i.test(cleaned) ? cleaned : `${cleaned}.wav`;
  return cleaned ? withExtension : "latest_converted.wav";
}

function storageHeaders() {
  return {
    apikey: sourceSupabaseKey,
    Authorization: `Bearer ${sourceSupabaseKey}`,
  };
}

async function githubRequest(path: string, init: RequestInit = {}) {
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN secret is missing");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "wav-convert-latest-mirror",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub ${path} failed with ${response.status}: ${text}`);
  }

  return response.json();
}

function base64FromArrayBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function fetchCurrentStorageObject() {
  const encodedBucket = encodeURIComponent(storageBucket);
  const encodedPath = storageObjectPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const objectUrl =
    `${sourceSupabaseUrl}/storage/v1/object/${encodedBucket}/${encodedPath}`;
  const infoUrl =
    `${sourceSupabaseUrl}/storage/v1/object/info/${encodedBucket}/${encodedPath}`;
  const cacheBuster = Date.now();

  const [infoResponse, fileResponse] = await Promise.all([
    fetch(`${infoUrl}?v=${cacheBuster}`, {
      headers: storageHeaders(),
    }),
    fetch(`${objectUrl}?download=${cacheBuster}`, {
      headers: storageHeaders(),
    }),
  ]);

  if (!infoResponse.ok) {
    throw new Error(`Storage info failed with ${infoResponse.status}`);
  }

  if (!fileResponse.ok) {
    throw new Error(`Storage download failed with ${fileResponse.status}`);
  }

  const info = await infoResponse.json();
  const fileBuffer = await fileResponse.arrayBuffer();

  return {
    fileBuffer,
    downloadName: safeDownloadName(info.metadata?.downloadName),
    savedAt: Number(info.metadata?.savedAt) || 0,
    size: Number(info.size) || fileBuffer.byteLength,
  };
}

async function getMirroredSavedAt() {
  try {
    const metadataFile = await githubRequest(
      `/repos/${githubRepo}/contents/${metadataRepoPath}?ref=${
        encodeURIComponent(githubBranch)
      }`,
    );

    if (metadataFile.type !== "file" || !metadataFile.content) {
      return 0;
    }

    const metadataText = atob(String(metadataFile.content).replace(/\s/g, ""));
    const metadata = JSON.parse(metadataText);
    return Number(metadata.savedAt) || 0;
  } catch (_err) {
    return 0;
  }
}

async function commitLatestMirror(
  fileBuffer: ArrayBuffer,
  downloadName: string,
  savedAt: number,
) {
  const ref = await githubRequest(
    `/repos/${githubRepo}/git/ref/heads/${githubBranch}`,
  );
  const headSha = ref.object.sha;
  const headCommit = await githubRequest(
    `/repos/${githubRepo}/git/commits/${headSha}`,
  );

  const audioBlob = await githubRequest(`/repos/${githubRepo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: base64FromArrayBuffer(fileBuffer),
      encoding: "base64",
    }),
  });
  const metadataBlob = await githubRequest(`/repos/${githubRepo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: `${JSON.stringify({ downloadName, savedAt }, null, 2)}\n`,
      encoding: "utf-8",
    }),
  });
  const tree = await githubRequest(`/repos/${githubRepo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: [
        {
          path: audioRepoPath,
          mode: "100644",
          type: "blob",
          sha: audioBlob.sha,
        },
        {
          path: metadataRepoPath,
          mode: "100644",
          type: "blob",
          sha: metadataBlob.sha,
        },
      ],
    }),
  });
  const commit = await githubRequest(`/repos/${githubRepo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Update latest converted audio: ${downloadName}`,
      tree: tree.sha,
      parents: [headSha],
    }),
  });

  await githubRequest(`/repos/${githubRepo}/git/refs/heads/${githubBranch}`, {
    method: "PATCH",
    body: JSON.stringify({
      sha: commit.sha,
      force: false,
    }),
  });

  return commit.sha;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const latest = await fetchCurrentStorageObject();
    if (!latest.savedAt) {
      return jsonResponse({
        ok: false,
        error: "Latest storage object has no savedAt metadata",
      }, 409);
    }

    const mirroredSavedAt = await getMirroredSavedAt();
    if (mirroredSavedAt >= latest.savedAt) {
      return jsonResponse({
        ok: true,
        changed: false,
        downloadName: latest.downloadName,
        savedAt: latest.savedAt,
      });
    }

    let commitSha = "";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        commitSha = await commitLatestMirror(
          latest.fileBuffer,
          latest.downloadName,
          latest.savedAt,
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }

    if (lastError) {
      throw lastError;
    }

    return jsonResponse({
      ok: true,
      changed: true,
      commitSha,
      downloadName: latest.downloadName,
      savedAt: latest.savedAt,
      size: latest.size,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
