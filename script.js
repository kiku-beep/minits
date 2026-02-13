// --- DOM Elements ---
const recordBtn = document.getElementById("record-btn");
const recordingButtons = document.getElementById("recording-buttons");
const pauseBtn = document.getElementById("pause-btn");
const stopBtn = document.getElementById("stop-btn");
const recordingStatus = document.getElementById("recording-status");
const recordingTimer = document.getElementById("recording-timer");
const levelMeterContainer = document.getElementById("level-meter-container");
const levelMeterSystem = document.getElementById("level-meter-system");
const levelMeterMic = document.getElementById("level-meter-mic");
const recordingHint = document.getElementById("recording-hint");
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
const systemAudioToggle = document.getElementById("system-audio-toggle");
const systemMeterLabel = levelMeterContainer.querySelector(".level-meter-label");
const systemMeterTrack = levelMeterContainer.querySelector(".level-meter-track");

// --- State ---
let mediaRecorder = null;
let recordedChunks = [];
let displayStream = null;
let micStream = null;
let audioContext = null;
let timerInterval = null;
let recordingStartTime = null;
let pausedElapsed = 0;
let levelAnimationId = null;
let systemAnalyser = null;
let micAnalyser = null;
let lastTranscript = "";
let lastMinutes = null;

// --- Audio Processing Constants ---
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_S = 120;

// --- Event Listeners ---
recordBtn.addEventListener("click", startRecording);
pauseBtn.addEventListener("click", togglePause);
stopBtn.addEventListener("click", stopRecording);
copyBtn.addEventListener("click", copyResult);
resetBtn.addEventListener("click", resetAll);
errorRetry.addEventListener("click", resetAll);
systemAudioToggle.addEventListener("change", () => {
  recordingHint.textContent = systemAudioToggle.checked
    ? "「録音を開始」を押すと、画面共有の選択ダイアログが表示されます"
    : "マイクで会議音声を録音します";
});

// ============================================================
// Recording
// ============================================================

async function startRecording() {
  const useSystemAudio = systemAudioToggle.checked;

  try {
    // 1. Get audio sources
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const destination = audioContext.createMediaStreamDestination();

    // Mic analyser (always active)
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(micAnalyser);
    micAnalyser.connect(destination);

    // System audio (optional)
    if (useSystemAudio) {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        systemAudio: "include",
      });

      displayStream.getVideoTracks().forEach((t) => t.stop());

      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "システム音声が共有されていません。画面共有ダイアログで「タブの音声を共有」にチェックを入れてください。"
        );
      }

      systemAnalyser = audioContext.createAnalyser();
      systemAnalyser.fftSize = 256;
      const systemSource = audioContext.createMediaStreamSource(displayStream);
      systemSource.connect(systemAnalyser);
      systemAnalyser.connect(destination);

      displayStream.getAudioTracks()[0].onended = () => {
        if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
          stopRecording();
        }
      };
    }

    // 2. MediaRecorder on mixed/mic stream
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    mediaRecorder = new MediaRecorder(destination.stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mimeType });
      processRecordedAudio(blob);
    };
    mediaRecorder.onerror = (e) => {
      console.error("MediaRecorder error:", e);
      stopRecording();
      showError("録音中にエラーが発生しました。");
    };

    mediaRecorder.start(1000);

    // 3. Update UI
    recordBtn.classList.add("hidden");
    recordingButtons.classList.remove("hidden");
    pauseBtn.textContent = "⏸ 一時停止";
    recordingStatus.classList.remove("hidden");
    recordingHint.classList.add("hidden");
    systemAudioToggle.disabled = true;

    // Show level meters — hide system meter row if mic-only
    levelMeterContainer.classList.remove("hidden");
    if (useSystemAudio) {
      systemMeterLabel.classList.remove("hidden");
      systemMeterTrack.classList.remove("hidden");
    } else {
      systemMeterLabel.classList.add("hidden");
      systemMeterTrack.classList.add("hidden");
    }

    startTimer();
    startLevelMeters();
  } catch (err) {
    cleanupStreams();
    if (err.name === "NotAllowedError") {
      return;
    }
    showError(err.message || "録音の開始に失敗しました。");
    uploadSection.classList.add("hidden");
    errorSection.classList.remove("hidden");
  }
}

function stopRecording() {
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
    mediaRecorder.stop();
  }
  stopTimer();
  stopLevelMeters();
  cleanupStreams();

  recordingButtons.classList.add("hidden");
  recordingStatus.classList.add("hidden");
  levelMeterContainer.classList.add("hidden");
}

function togglePause() {
  if (!mediaRecorder) return;

  if (mediaRecorder.state === "recording") {
    mediaRecorder.pause();
    pausedElapsed += Math.floor((Date.now() - recordingStartTime) / 1000);
    stopTimer();
    stopLevelMeters();
    pauseBtn.textContent = "▶ 再開";
    document.querySelector(".recording-indicator").style.animationPlayState = "paused";
  } else if (mediaRecorder.state === "paused") {
    mediaRecorder.resume();
    recordingStartTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    startLevelMeters();
    pauseBtn.textContent = "⏸ 一時停止";
    document.querySelector(".recording-indicator").style.animationPlayState = "running";
  }
}

function cleanupStreams() {
  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
    audioContext = null;
  }
  systemAnalyser = null;
  micAnalyser = null;
}

// ============================================================
// Timer
// ============================================================

function startTimer() {
  pausedElapsed = 0;
  recordingStartTime = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function updateTimer() {
  const elapsed = pausedElapsed + Math.floor((Date.now() - recordingStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  recordingTimer.textContent = `${h}:${m}:${s}`;
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ============================================================
// Level Meters
// ============================================================

function startLevelMeters() {
  function updateLevels() {
    if (systemAnalyser) {
      const data = new Uint8Array(systemAnalyser.frequencyBinCount);
      systemAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      levelMeterSystem.style.width = Math.min(100, (avg / 128) * 100) + "%";
    }
    if (micAnalyser) {
      const data = new Uint8Array(micAnalyser.frequencyBinCount);
      micAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      levelMeterMic.style.width = Math.min(100, (avg / 128) * 100) + "%";
    }
    levelAnimationId = requestAnimationFrame(updateLevels);
  }
  updateLevels();
}

function stopLevelMeters() {
  if (levelAnimationId) {
    cancelAnimationFrame(levelAnimationId);
    levelAnimationId = null;
  }
  if (levelMeterSystem) levelMeterSystem.style.width = "0%";
  if (levelMeterMic) levelMeterMic.style.width = "0%";
}

// ============================================================
// Audio Processing: Resample → Chunk → WAV Encode
// ============================================================

function resampleToMono16k(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numChannels;
    }
  }

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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ============================================================
// Processing Pipeline
// ============================================================

async function processRecordedAudio(blob) {
  showProgress();
  hideError();

  try {
    if (blob.size === 0) {
      throw new Error("録音データが空です。音声が正しく共有されていたか確認してください。");
    }

    setProgress(5, "録音データを読み込み中...");
    const arrayBuffer = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();

    let audioBuffer;
    try {
      audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
    } finally {
      await decodeCtx.close();
    }

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

    const transcript = transcriptParts.join("\n");

    if (!transcript.trim()) {
      throw new Error("音声を認識できませんでした。システム音声とマイクが正しく入力されているか確認してください。");
    }

    lastTranscript = transcript;

    setProgress(75, "議事録を生成中...");
    const minutes = await generateMinutes(transcript);
    lastMinutes = minutes;

    setProgress(95, "完了！");
    setTimeout(() => showResult(minutes, transcript), 300);
  } catch (err) {
    console.error("Processing failed:", err);
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

  const summary = minutes.summary || "";
  if (summary) {
    resultSummary.innerHTML = `<h3>要約</h3><p>${escapeHtml(summary)}</p>`;
    resultSummary.classList.remove("hidden");
  } else {
    resultSummary.classList.add("hidden");
  }

  const agenda = minutes.agenda || [];
  if (agenda.length > 0) {
    resultAgenda.innerHTML =
      `<h3>議題</h3><ol>${agenda.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ol>`;
    resultAgenda.classList.remove("hidden");
  } else {
    resultAgenda.classList.add("hidden");
  }

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

  transcriptText.textContent = transcript;
}

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

function resetAll() {
  cleanupStreams();
  stopTimer();
  stopLevelMeters();

  recordBtn.classList.remove("hidden");
  recordingButtons.classList.add("hidden");
  recordingStatus.classList.add("hidden");
  levelMeterContainer.classList.add("hidden");
  recordingHint.classList.remove("hidden");
  recordingTimer.textContent = "00:00:00";
  systemAudioToggle.disabled = false;

  uploadSection.classList.remove("hidden");
  progressSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  progressBar.style.width = "0%";
  lastTranscript = "";
  lastMinutes = null;
  recordedChunks = [];
  mediaRecorder = null;
}

function showError(message) {
  progressSection.classList.add("hidden");
  errorSection.classList.remove("hidden");
  errorText.textContent = message;
}

function hideError() {
  errorSection.classList.add("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
