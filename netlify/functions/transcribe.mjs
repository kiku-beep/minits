import OpenAI from "openai";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response("OpenAI API key is not configured", { status: 500 });
  }

  try {
    const formData = await req.formData();
    const audioFile = formData.get("audio");

    if (!audioFile) {
      return new Response("No audio file provided", { status: 400 });
    }

    // File size check (OpenAI limit: 25MB)
    if (audioFile.size > 25 * 1024 * 1024) {
      return new Response("ファイルサイズが25MBを超えています。圧縮してから再度お試しください。", {
        status: 413,
      });
    }

    const openai = new OpenAI({ apiKey });

    // Convert web File to the format OpenAI SDK expects
    const file = new File([await audioFile.arrayBuffer()], audioFile.name, {
      type: audioFile.type,
    });

    const transcription = await openai.audio.transcriptions.create({
      model: process.env.WHISPER_MODEL || "whisper-1",
      file: file,
      language: process.env.WHISPER_LANGUAGE || "ja",
    });

    return Response.json({ text: transcription.text });

  } catch (err) {
    console.error("Transcription error:", err);
    const message = err.message || "文字起こしに失敗しました";
    return new Response(message, { status: 500 });
  }
};

export const config = {
  path: "/api/transcribe",
};
