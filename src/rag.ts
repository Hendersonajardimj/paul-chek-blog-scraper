import OpenAI from "openai";
import {
  initDb,
  initRagDb,
  getPostsNeedingChunks,
  insertChunk,
  getChunksNeedingEmbeddings,
  updateChunkEmbedding,
  searchChunks,
  getChunkStats,
  ChunkRecord,
} from "./db";

// Configuration
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 3072;
const MAX_TOKENS_PER_CHUNK = 500;
const CHUNK_OVERLAP_TOKENS = 50;
const BATCH_SIZE = 100; // OpenAI embedding batch size

// Lazy initialization of OpenAI client
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set. Please add it to your .env file.");
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/**
 * Rough token count estimation (4 chars ~= 1 token for English)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Semantic chunking - splits text by headings and paragraphs
 * Respects natural boundaries while staying within token limits
 */
export function semanticChunk(
  text: string,
  maxTokens: number = MAX_TOKENS_PER_CHUNK,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS
): Array<{ content: string; heading?: string; tokenCount: number }> {
  const chunks: Array<{ content: string; heading?: string; tokenCount: number }> = [];

  // Split by headings (markdown style)
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  const sections: Array<{ heading?: string; content: string }> = [];

  let lastIndex = 0;
  let currentHeading: string | undefined;
  let match;

  // Find all headings and split content
  const matches: Array<{ index: number; heading: string; level: number }> = [];
  while ((match = headingPattern.exec(text)) !== null) {
    matches.push({
      index: match.index,
      heading: match[2].trim(),
      level: match[1].length,
    });
  }

  if (matches.length === 0) {
    // No headings, treat as single section
    sections.push({ content: text.trim() });
  } else {
    // Split by headings
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const nextIndex = matches[i + 1]?.index ?? text.length;

      // Content before first heading
      if (i === 0 && m.index > 0) {
        const beforeContent = text.slice(0, m.index).trim();
        if (beforeContent) {
          sections.push({ content: beforeContent });
        }
      }

      // Content under this heading
      const headingLineEnd = text.indexOf("\n", m.index);
      const sectionContent = text.slice(headingLineEnd + 1, nextIndex).trim();
      if (sectionContent) {
        sections.push({ heading: m.heading, content: sectionContent });
      }
    }
  }

  // Process each section into chunks
  for (const section of sections) {
    const sectionTokens = estimateTokens(section.content);

    if (sectionTokens <= maxTokens) {
      // Section fits in one chunk
      chunks.push({
        content: section.content,
        heading: section.heading,
        tokenCount: sectionTokens,
      });
    } else {
      // Split section by paragraphs
      const paragraphs = section.content.split(/\n\n+/);
      let currentChunk = "";
      let currentTokens = 0;

      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);

        if (currentTokens + paraTokens <= maxTokens) {
          currentChunk += (currentChunk ? "\n\n" : "") + para;
          currentTokens += paraTokens;
        } else {
          // Save current chunk
          if (currentChunk) {
            chunks.push({
              content: currentChunk,
              heading: section.heading,
              tokenCount: currentTokens,
            });
          }

          // Start new chunk with overlap
          if (overlapTokens > 0 && currentChunk) {
            // Get last ~overlapTokens worth of content
            const overlapChars = overlapTokens * 4;
            const overlap = currentChunk.slice(-overlapChars);
            currentChunk = overlap + "\n\n" + para;
            currentTokens = estimateTokens(currentChunk);
          } else {
            currentChunk = para;
            currentTokens = paraTokens;
          }

          // If single paragraph exceeds max, split by sentences
          if (currentTokens > maxTokens) {
            const sentences = para.split(/(?<=[.!?])\s+/);
            currentChunk = "";
            currentTokens = 0;

            for (const sentence of sentences) {
              const sentenceTokens = estimateTokens(sentence);
              if (currentTokens + sentenceTokens <= maxTokens) {
                currentChunk += (currentChunk ? " " : "") + sentence;
                currentTokens += sentenceTokens;
              } else {
                if (currentChunk) {
                  chunks.push({
                    content: currentChunk,
                    heading: section.heading,
                    tokenCount: currentTokens,
                  });
                }
                currentChunk = sentence;
                currentTokens = sentenceTokens;
              }
            }
          }
        }
      }

      // Don't forget the last chunk
      if (currentChunk) {
        chunks.push({
          content: currentChunk,
          heading: section.heading,
          tokenCount: estimateTokens(currentChunk),
        });
      }
    }
  }

  return chunks;
}

/**
 * Generate embeddings for a batch of texts
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data.map((d) => d.embedding);
}

/**
 * Generate embedding for a single query
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: query,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0].embedding;
}

/**
 * Process all posts that need chunking
 */
export async function chunkAllPosts(): Promise<{ postsProcessed: number; chunksCreated: number }> {
  const posts = await getPostsNeedingChunks();
  console.log(`Found ${posts.length} posts needing chunks`);

  let chunksCreated = 0;

  for (const post of posts) {
    const chunks = semanticChunk(post.markdown);
    console.log(`  ${post.title.slice(0, 50)}... -> ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const record: ChunkRecord = {
        postId: post.id,
        chunkIndex: i,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        heading: chunk.heading,
      };

      await insertChunk(record);
      chunksCreated++;
    }
  }

  return { postsProcessed: posts.length, chunksCreated };
}

/**
 * Generate embeddings for all chunks that need them
 */
export async function embedAllChunks(): Promise<{ chunksProcessed: number; tokensUsed: number }> {
  let totalProcessed = 0;
  let totalTokens = 0;

  while (true) {
    const chunks = await getChunksNeedingEmbeddings(BATCH_SIZE);
    if (chunks.length === 0) break;

    console.log(`Processing batch of ${chunks.length} chunks...`);

    const texts = chunks.map((c) => c.content);
    const embeddings = await generateEmbeddings(texts);

    for (let i = 0; i < chunks.length; i++) {
      await updateChunkEmbedding(chunks[i].id, embeddings[i]);
      totalTokens += estimateTokens(texts[i]);
    }

    totalProcessed += chunks.length;
    console.log(`  Processed ${totalProcessed} chunks so far`);
  }

  return { chunksProcessed: totalProcessed, tokensUsed: totalTokens };
}

/**
 * Search for relevant chunks given a query
 */
export async function search(
  query: string,
  limit: number = 10,
  source?: string
): Promise<Array<{ content: string; heading: string | null; similarity: number; title: string; url: string }>> {
  const queryEmbedding = await generateQueryEmbedding(query);
  const results = await searchChunks(queryEmbedding, limit, source);

  return results.map((r) => ({
    content: r.content,
    heading: r.heading,
    similarity: r.similarity,
    title: r.title,
    url: r.url,
  }));
}

/**
 * Main CLI for RAG operations
 */
async function main() {
  const command = process.argv[2];

  await initDb();
  const ragResult = await initRagDb();

  if (!ragResult.success) {
    console.error("Failed to initialize RAG database:");
    console.error(ragResult.error);
    process.exit(1);
  }

  switch (command) {
    case "chunk": {
      console.log("=".repeat(60));
      console.log("Chunking all posts...");
      console.log("=".repeat(60));
      const { postsProcessed, chunksCreated } = await chunkAllPosts();
      console.log(`\nDone! Processed ${postsProcessed} posts, created ${chunksCreated} chunks.`);
      break;
    }

    case "embed": {
      console.log("=".repeat(60));
      console.log("Generating embeddings for all chunks...");
      console.log("=".repeat(60));
      const { chunksProcessed, tokensUsed } = await embedAllChunks();
      const estimatedCost = (tokensUsed / 1_000_000) * 0.13; // $0.13 per 1M tokens
      console.log(`\nDone! Processed ${chunksProcessed} chunks.`);
      console.log(`Estimated tokens used: ${tokensUsed} (~$${estimatedCost.toFixed(4)})`);
      break;
    }

    case "stats": {
      const stats = await getChunkStats();
      console.log("=".repeat(60));
      console.log("RAG Pipeline Stats");
      console.log("=".repeat(60));
      console.log(`Total chunks: ${stats.totalChunks}`);
      console.log(`With embeddings: ${stats.withEmbeddings}`);
      console.log(`Without embeddings: ${stats.withoutEmbeddings}`);
      break;
    }

    case "search": {
      const query = process.argv.slice(3).join(" ");
      if (!query) {
        console.error("Usage: npm run rag search <query>");
        process.exit(1);
      }

      console.log(`Searching for: "${query}"\n`);
      const results = await search(query, 5);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        console.log(`--- Result ${i + 1} (${(r.similarity * 100).toFixed(1)}% match) ---`);
        console.log(`Title: ${r.title}`);
        console.log(`URL: ${r.url}`);
        if (r.heading) console.log(`Section: ${r.heading}`);
        console.log(`\n${r.content.slice(0, 500)}...`);
        console.log();
      }
      break;
    }

    default:
      console.log("RAG Pipeline Commands:");
      console.log("  npm run rag chunk   - Chunk all posts into semantic segments");
      console.log("  npm run rag embed   - Generate embeddings for all chunks");
      console.log("  npm run rag stats   - Show chunking/embedding statistics");
      console.log("  npm run rag search <query> - Search the corpus");
      console.log("\nTypical workflow:");
      console.log("  1. npm run rag chunk");
      console.log("  2. npm run rag embed");
      console.log("  3. npm run rag search 'your question here'");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
