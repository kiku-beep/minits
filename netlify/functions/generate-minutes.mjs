import { GoogleGenAI } from "@google/genai";

const SYSTEM_PROMPT = `あなたは会議の議事録を作成するアシスタントです。
音声から文字起こしされたテキストを元に、構造化された議事録を作成します。

## 出力フォーマット（JSON）
以下のJSON形式で出力してください：

{
  "title": "会議のタイトル（内容から推測）",
  "summary": "会議の要約（3-5文）",
  "participants": ["参加者名のリスト（発言から推測）"],
  "agenda": ["議題1", "議題2"],
  "decisions": [
    {"content": "決定事項の内容", "context": "背景・理由"}
  ],
  "action_items": [
    {"assignee": "担当者", "task": "タスク内容", "deadline": "期限（言及があれば）"}
  ],
  "discussion_points": [
    {"topic": "議論のトピック", "details": "議論の要点"}
  ]
}

## ルール
- 元の発言内容に忠実に。推測で情報を追加しない
- 参加者名は発言中の呼びかけや自己紹介から推測する
- 期限や担当者が明確でない場合は「未定」と記載
- 技術用語はそのまま保持
- 日本語で出力（固有名詞・技術用語は原語のまま）
- JSON以外のテキストを出力しない`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response("Gemini API key is not configured", { status: 500 });
  }

  try {
    const { transcript } = await req.json();

    if (!transcript || !transcript.trim()) {
      return new Response("No transcript provided", { status: 400 });
    }

    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const response = await ai.models.generateContent({
      model,
      contents: `--- 文字起こしテキスト ---\n${transcript}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.1,
      },
    });

    const raw = response.text.trim();

    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    let minutes;
    try {
      minutes = JSON.parse(cleaned);
    } catch {
      // If JSON parse fails, return a fallback structure
      minutes = {
        title: "会議メモ",
        summary: "自動要約に失敗しました。文字起こしテキストを参照してください。",
        participants: [],
        agenda: [],
        decisions: [],
        action_items: [],
        discussion_points: [],
      };
    }

    // Ensure all expected fields exist
    const defaults = {
      title: "会議メモ",
      summary: "",
      participants: [],
      agenda: [],
      decisions: [],
      action_items: [],
      discussion_points: [],
    };
    for (const [key, val] of Object.entries(defaults)) {
      if (!(key in minutes)) minutes[key] = val;
    }

    return Response.json(minutes);

  } catch (err) {
    console.error("Minutes generation error:", err);
    const message = err.message || "議事録生成に失敗しました";
    return new Response(message, { status: 500 });
  }
};

export const config = {
  path: "/api/generate-minutes",
};
