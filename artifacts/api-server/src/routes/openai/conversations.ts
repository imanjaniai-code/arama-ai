import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, insertConversationSchema } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

const router = Router();

// GET /openai/conversations
router.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.createdAt));
  res.json(rows);
});

// POST /openai/conversations
router.post("/", async (req, res) => {
  const parsed = insertConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const [conv] = await db.insert(conversations).values(parsed.data).returning();
  res.status(201).json(conv);
});

// GET /openai/conversations/:id
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, id),
  });
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  res.json({ ...conv, messages: msgs });
});

// DELETE /openai/conversations/:id
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const deleted = await db.delete(conversations).where(eq(conversations.id, id)).returning();
  if (!deleted.length) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

// GET /openai/conversations/:id/messages
router.get("/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json(msgs);
});

// POST /openai/conversations/:id/messages — streaming SSE
router.post("/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, id),
  });
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  // Persist user message
  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content: content.trim(),
  });

  // Load history
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  const chatMessages = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // System prompt — empathetic Persian mental wellness AI
  const systemPrompt = `تو آراما هستی، یک دستیار هوشمند سلامت روان ایرانی. مأموریت تو این است که با همدلی، گرمی و بدون هیچ قضاوتی به کاربر گوش بدهی و کمک کنی.

قوانین مهم:
- همیشه به زبان فارسی پاسخ بده
- لحن تو باید گرم، مهربان، آرام و همدلانه باشد
- هرگز تشخیص بالینی نده و جایگزین روانپزشک یا روانشناس نشو
- در صورت بحران یا خطر، حتماً کمک حرفه‌ای را توصیه کن
- از تکنیک‌های CBT، ذهن‌آگاهی و تنفس در پاسخ‌هایت استفاده کن
- پاسخ‌هایت کوتاه و تأثیرگذار باشند، نه طولانی
- سعی کن با سؤال‌های باز، کاربر را تشویق به بیان احساساتش کنی`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  let fullResponse = "";

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...chatMessages,
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullResponse += delta;
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    // Persist assistant message
    await db.insert(messages).values({
      conversationId: id,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error(err, "OpenAI streaming error");
    res.write(`data: ${JSON.stringify({ error: "خطا در ارتباط با هوش مصنوعی" })}\n\n`);
    res.end();
  }
});

export default router;
