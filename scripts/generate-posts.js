import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const QUEUE_FILE = path.join(ROOT, "scheduled-posts.json");
const BLOG_DIR = path.join(ROOT, "src/data/blog");

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
console.log(`API key prefix: ${apiKey ? apiKey.substring(0, 15) : "NOT SET"}`);
console.log(`API key length in Node: ${apiKey?.length ?? 0}`);

// Quick connectivity test before running posts
const testRes = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": apiKey ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
});
console.log(`Direct API test status: ${testRes.status}`);
if (!testRes.ok) {
  const errBody = await testRes.text();
  console.error("API error body:", errBody);
  process.exit(1);
}

const client = new Anthropic({ apiKey });

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function formatDatetime(isoString) {
  return new Date(isoString).toISOString().replace("Z", "+00:00");
}

async function generatePost(entry) {
  const hintSection = entry.hint
    ? `\n\nExtra guidance from the editor: ${entry.hint}`
    : "";

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    system: [
      {
        type: "text",
        text: `You are an expert blog writer. Write engaging, well-structured, SEO-optimized blog posts in Markdown.

Rules:
- Write in a clear, authoritative, and engaging tone
- Use h2 (##) and h3 (###) for section headings — never h1
- Include a practical introduction and a strong conclusion
- Use bullet points and numbered lists where appropriate
- Aim for 800–1200 words
- Do NOT include the post title as a heading — it's set in frontmatter
- Do NOT add YAML frontmatter — that is handled separately
- Output ONLY the markdown body content, nothing else`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Write a blog post titled: "${entry.title}"${hintSection}`,
      },
    ],
  });

  return response.content[0].text;
}

async function run() {
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log("No scheduled-posts.json found. Nothing to do.");
    process.exit(0);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  const now = new Date();

  const due = queue.filter(
    (p) => p.status === "pending" && new Date(p.scheduledFor) <= now
  );

  if (due.length === 0) {
    console.log("No posts due for publishing.");
    process.exit(0);
  }

  console.log(`Found ${due.length} post(s) to publish.`);

  for (const entry of due) {
    console.log(`Generating: "${entry.title}"`);

    try {
      const body = await generatePost(entry);
      const slug = slugify(entry.title);
      const tags = entry.tags && entry.tags.length > 0 ? entry.tags : ["general"];
      const tagsYaml = tags.map((t) => `"${t}"`).join(", ");

      const frontmatter = `---
title: "${entry.title.replace(/"/g, '\\"')}"
description: ""
pubDatetime: ${formatDatetime(entry.scheduledFor)}
tags: [${tagsYaml}]
featured: false
draft: false
---

`;

      const filename = `${slug}.md`;
      const filepath = path.join(BLOG_DIR, filename);

      if (fs.existsSync(filepath)) {
        console.warn(`  ⚠ File already exists, skipping: ${filename}`);
        continue;
      }

      fs.writeFileSync(filepath, frontmatter + body, "utf-8");
      console.log(`  ✓ Written: src/data/blog/${filename}`);

      const idx = queue.findIndex((p) => p.id === entry.id);
      queue[idx].status = "published";
      queue[idx].publishedAt = now.toISOString();
    } catch (err) {
      console.error(`  ✗ Failed to generate "${entry.title}":`, err.message);
      const idx = queue.findIndex((p) => p.id === entry.id);
      queue[idx].status = "error";
      queue[idx].error = err.message;
    }
  }

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf-8");
  console.log("Queue updated.");
}

run();
