// --- DOM Elements ---
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview");
const fileName = document.getElementById("file-name");
const fileSize = document.getElementById("file-size");
const removeFile = document.getElementById("remove-file");
const generateBtn = document.getElementById("generate-btn");
const uploadSection = document.getElementById("upload-section");
const progressSection = document.getElementById("progress-section");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const resultSection = document.getElementById("result-section");
const resultTitle = document.getElementById("result-title");
const resultSummary = document.getElementById("result-summary");
const resultAgenda = document.getElementById("result-agenda");
const resultDecisions = document.getElementById("result-decisions");
const resultActionsList = document.getElementById("result-actions-list");
const resultDiscussion = document.getElementById("result-discussion");
const transcriptText = document.getElementById("transcript-text");
const copyBtn = document.getElementById("copy-btn");
const resetBtn = document.getElementById("reset-btn");
const errorSection = document.getElementById("error-section");
const errorText = document.getElementById("error-text");
const errorRetry = document.getElementById("error-retry");

let selectedFile = null;
let lastTranscript = "";
let lastMinutes = null;

// --- Audio Processing Constants ---
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_S = 120; // 2 minutes per chunk
// 2min * 16kHz * 2bytes (int16) + 44 (WAV header) ≈ 3.84MB — fits in Netlify Function limit
const SMALL_FILE_THRESHOLD = 4.5 * 1024 * 1024; // Files under 4.5MB sent directly

// --- File Upload ---
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    selectFile(e.dataTransfer.files[0]);
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    selectFile(fileInput.files[0]);
  }
});

removeFile.addEventListener("click", clearFile);
generateBtn.addEventListener("click", startGeneration);
copyBtn.addEventListener("click", copyResult);
resetBtn.addEventListener("click", resetAll);
errorRetry.addEventListener("click", startGeneration);

function selectFile(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatFileSize(file.size);
  dropZone.classList.add("hidden");
  filePreview.classList.remove("hidden");
  generateBtn.classList.remove("hidden");
  generateBtn.disabled = false;
}

function clearFile() {
  selectedFile = null;
  fileInput.value = "";
  dropZone.classList.remove("hidden");
  filePreview.classList.add("hidden");
  generateBtn.classList.add("hidden");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ============================================================
// Audio Processing: Decode → Resample → Chunk → WAV Encode
// ============================================================

async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    return decoded;
  } finally {
    await audioCtx.close();
  }
}

function resampleToMono16k(audioBuffer) {
  // Get mono channel (average all channels)
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numChannels;
    }
  }

  // Resample to 16kHz using linear interpolation
  const srcRate = audioBuffer.sampleRate;
  if (srcRate === TARGET_SAMPLE_RATE) {
    return mono;
  }

  const ratio = srcRate / TARGET_SAMPLE_RATE;
  const newLength = Math.floor(length / ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, length - 1);
    const frac = srcIndex - low;
    resampled[i] = mono[low] * (1 - frac) + mono[high] * frac;
  }

  return resampled;
}

function splitIntoChunks(samples) {
  const samplesPerChunk = TARGET_SAMPLE_RATE * CHUNK_DURATION_S;
  const chunks = [];

  for (let offset = 0; offset < samples.length; offset += samplesPerChunk) {
    const end = Math.min(offset + samplesPerChunk, samples.length);
    chunks.push(samples.subarray(offset, end));
  }

  return chunks;
}

function encodeWAV(samples) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);           // subchunk1 size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Float32 → Int16
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ============================================================
// Generation Pipeline
// ============================================================

async function startGeneration() {
  if (!selectedFile) return;

  showProgress();
  hideError();

  try {
    let transcript;

    if (selectedFile.size <= SMALL_FILE_THRESHOLD) {
      // Small file: send directly without chunking
      setProgress(10, "文字起こし中...");
      transcript = await transcribeBlob(selectedFile, selectedFile.name);
    } else {
      // Large file: decode, chunk, and process sequentially
      setProgress(5, "音声ファイルを読み込み中...");
      const audioBuffer = await decodeAudioFile(selectedFile);

      setProgress(10, "音声データを処理中...");
      const samples = resampleToMono16k(audioBuffer);
      const chunks = splitIntoChunks(samples);

      const totalChunks = chunks.length;
      const transcriptParts = [];

      for (let i = 0; i < totalChunks; i++) {
        const pct = 10 + Math.round((i / totalChunks) * 60);
        setProgress(pct, `文字起こし中... (${i + 1}/${totalChunks})`);

        const wavBlob = encodeWAV(chunks[i]);
        const partText = await transcribeBlob(wavBlob, `chunk_${i}.wav`);
        if (partText.trim()) {
          transcriptParts.push(partText.trim());
        }
      }

      transcript = transcriptParts.join("\n");
    }

    if (!transcript.trim()) {
      throw new Error("音声を認識できませんでした。ファイルに音声が含まれているか確認してください。");
    }

    lastTranscript = transcript;

    // Generate minutes
    setProgress(75, "議事録を生成中...");
    const minutes = await generateMinutes(transcript);
    lastMinutes = minutes;

    setProgress(95, "完了！");
    setTimeout(() => showResult(minutes, transcript), 300);

  } catch (err) {
    console.error("Generation failed:", err);
    showError(err.message || "処理中にエラーが発生しました。");
  }
}

async function transcribeBlob(blob, filename) {
  const formData = new FormData();
  formData.append("audio", blob, filename);

  const resp = await fetch("/api/transcribe", {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(body || `文字起こしに失敗しました (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  return data.text;
}

async function generateMinutes(transcript) {
  const resp = await fetch("/api/generate-minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(body || `議事録生成に失敗しました (HTTP ${resp.status})`);
  }

  return await resp.json();
}

// ============================================================
// UI
// ============================================================

function showProgress() {
  uploadSection.classList.add("hidden");
  progressSection.classList.remove("hidden");
  resultSection.classList.add("hidden");
  errorSection.classList.add("hidden");
}

function setProgress(percent, text) {
  progressBar.style.width = percent + "%";
  progressText.textContent = text;
}

function showResult(minutes, transcript) {
  progressSection.classList.add("hidden");
  resultSection.classList.remove("hidden");

  resultTitle.textContent = minutes.title || "会議メモ";

  // Summary
  const summary = minutes.summary || "";
  if (summary) {
    resultSummary.innerHTML = `<h3>要約</h3><p>${escapeHtml(summary)}</p>`;
    resultSummary.classList.remove("hidden");
  } else {
    resultSummary.classList.add("hidden");
  }

  // Agenda
  const agenda = minutes.agenda || [];
  if (agenda.length > 0) {
    resultAgenda.innerHTML =
      `<h3>議題</h3><ol>${agenda.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ol>`;
    resultAgenda.classList.remove("hidden");
  } else {
    resultAgenda.classList.add("hidden");
  }

  // Decisions
  const decisions = minutes.decisions || [];
  if (decisions.length > 0) {
    const items = decisions.map((d) => {
      const content = typeof d === "string" ? d : d.content || "";
      const context = typeof d === "string" ? "" : d.context || "";
      return `<li><strong>${escapeHtml(content)}</strong>${context ? " — " + escapeHtml(context) : ""}</li>`;
    });
    resultDecisions.innerHTML = `<h3>決定事項</h3><ul>${items.join("")}</ul>`;
    resultDecisions.classList.remove("hidden");
  } else {
    resultDecisions.classList.add("hidden");
  }

  // Action Items
  const actions = minutes.action_items || [];
  if (actions.length > 0) {
    const rows = actions.map((a) => {
      if (typeof a === "string") return `<tr><td>未定</td><td>${escapeHtml(a)}</td><td>未定</td></tr>`;
      return `<tr><td>${escapeHtml(a.assignee || "未定")}</td><td>${escapeHtml(a.task || "")}</td><td>${escapeHtml(a.deadline || "未定")}</td></tr>`;
    });
    resultActionsList.innerHTML = `
      <h3>アクションアイテム</h3>
      <table class="action-table">
        <thead><tr><th>担当者</th><th>タスク</th><th>期限</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
    resultActionsList.classList.remove("hidden");
  } else {
    resultActionsList.classList.add("hidden");
  }

  // Discussion Points
  const discussion = minutes.discussion_points || [];
  if (discussion.length > 0) {
    const items = discussion.map((p) => {
      if (typeof p === "string") return `<li>${escapeHtml(p)}</li>`;
      return `<li><strong>${escapeHtml(p.topic || "")}</strong>: ${escapeHtml(p.details || "")}</li>`;
    });
    resultDiscussion.innerHTML = `<h3>議論のポイント</h3><ul>${items.join("")}</ul>`;
    resultDiscussion.classList.remove("hidden");
  } else {
    resultDiscussion.classList.add("hidden");
  }

  // Transcript
  transcriptText.textContent = transcript;
}

// --- Copy ---
function copyResult() {
  if (!lastMinutes) return;

  const m = lastMinutes;
  let text = `# ${m.title || "会議メモ"}\n\n`;

  if (m.summary) text += `## 要約\n${m.summary}\n\n`;

  if (m.agenda && m.agenda.length > 0) {
    text += `## 議題\n${m.agenda.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n`;
  }

  if (m.decisions && m.decisions.length > 0) {
    text += `## 決定事項\n`;
    m.decisions.forEach((d) => {
      const content = typeof d === "string" ? d : d.content || "";
      const context = typeof d === "string" ? "" : d.context || "";
      text += `- ${content}${context ? " — " + context : ""}\n`;
    });
    text += "\n";
  }

  if (m.action_items && m.action_items.length > 0) {
    text += `## アクションアイテム\n| 担当者 | タスク | 期限 |\n|--|--|--|\n`;
    m.action_items.forEach((a) => {
      if (typeof a === "string") {
        text += `| 未定 | ${a} | 未定 |\n`;
      } else {
        text += `| ${a.assignee || "未定"} | ${a.task || ""} | ${a.deadline || "未定"} |\n`;
      }
    });
    text += "\n";
  }

  if (m.discussion_points && m.discussion_points.length > 0) {
    text += `## 議論のポイント\n`;
    m.discussion_points.forEach((p) => {
      if (typeof p === "string") {
        text += `- ${p}\n`;
      } else {
        text += `- **${p.topic || ""}**: ${p.details || ""}\n`;
      }
    });
  }

  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = "✅ コピー済み";
    copyBtn.classList.add("copy-success");
    setTimeout(() => {
      copyBtn.textContent = "📋 コピー";
      copyBtn.classList.remove("copy-success");
    }, 2000);
  });
}

// --- Reset ---
function resetAll() {
  clearFile();
  uploadSection.classList.remove("hidden");
  progressSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  progressBar.style.width = "0%";
  lastTranscript = "";
  lastMinutes = null;
}

// --- Error ---
function showError(message) {
  progressSection.classList.add("hidden");
  errorSection.classList.remove("hidden");
  errorText.textContent = message;
}

function hideError() {
  errorSection.classList.add("hidden");
}

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
