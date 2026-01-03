import { Pool } from "pg";

export type PostRecord = {
  url: string;
  slug: string;
  title: string;
  datePublished: string | null;
  doctorSection: string;
  categories: string[];
  tags: string[];
  markdown: string;
  source?: string; // 'paul-chek-blog' | 'founders-podcast'
};

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "DATABASE_URL is not set. Database persistence will be disabled until it is configured."
  );
}

const pool = connectionString
  ? new Pool({ connectionString })
  : null;

export async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      date_published TIMESTAMPTZ NULL,
      doctor_section TEXT NOT NULL,
      categories TEXT[] NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      markdown TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'paul-chek-blog',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migration: add source column if it doesn't exist (for existing databases)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'posts' AND column_name = 'source'
      ) THEN
        ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'paul-chek-blog';
      END IF;
    END $$;
  `);
}

/**
 * Check if pgvector extension is available
 */
export async function checkPgvectorAvailable(): Promise<boolean> {
  if (!pool) return false;

  try {
    const result = await pool.query(`
      SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Initialize pgvector extension and chunks table for RAG pipeline
 */
export async function initRagDb(): Promise<{ success: boolean; error?: string }> {
  if (!pool) return { success: false, error: "No database connection" };

  // Check if pgvector is available
  const pgvectorAvailable = await checkPgvectorAvailable();
  if (!pgvectorAvailable) {
    return {
      success: false,
      error: `pgvector extension is not available on your PostgreSQL server.

To install pgvector:
1. If using Railway: Use a PostgreSQL template with pgvector support, or install manually
2. If using local PostgreSQL:
   - macOS: brew install pgvector
   - Ubuntu: sudo apt install postgresql-17-pgvector
   - Then run: CREATE EXTENSION vector;

See: https://github.com/pgvector/pgvector#installation`
    };
  }

  try {
    // Enable pgvector extension
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // Create chunks table with vector column (3072 dimensions for text-embedding-3-large)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        heading TEXT,
        embedding vector(3072),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(post_id, chunk_index)
      );
    `);

    // Create index for vector similarity search (only if we have enough rows)
    // IVFFlat index requires at least lists * 10 rows
    const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM chunks`);
    const chunkCount = parseInt(countResult.rows[0].count, 10);

    if (chunkCount >= 1000) {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
      `);
    }

    // Create index for filtering by post
    await pool.query(`
      CREATE INDEX IF NOT EXISTS chunks_post_id_idx ON chunks(post_id);
    `);

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ChunkRecord = {
  postId: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  heading?: string;
  embedding?: number[];
};

/**
 * Insert a chunk into the database
 */
export async function insertChunk(chunk: ChunkRecord): Promise<number> {
  if (!pool) return -1;

  const embeddingStr = chunk.embedding
    ? `[${chunk.embedding.join(',')}]`
    : null;

  const result = await pool.query<{ id: number }>(
    `INSERT INTO chunks (post_id, chunk_index, content, token_count, heading, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector)
     ON CONFLICT (post_id, chunk_index) DO UPDATE SET
       content = EXCLUDED.content,
       token_count = EXCLUDED.token_count,
       heading = EXCLUDED.heading,
       embedding = EXCLUDED.embedding
     RETURNING id`,
    [chunk.postId, chunk.chunkIndex, chunk.content, chunk.tokenCount, chunk.heading || null, embeddingStr]
  );

  return result.rows[0]?.id ?? -1;
}

/**
 * Get all posts that need chunking (no chunks yet)
 */
export async function getPostsNeedingChunks(): Promise<Array<{ id: number; url: string; title: string; markdown: string; source: string }>> {
  if (!pool) return [];

  const result = await pool.query<{ id: number; url: string; title: string; markdown: string; source: string }>(`
    SELECT p.id, p.url, p.title, p.markdown, p.source
    FROM posts p
    LEFT JOIN chunks c ON p.id = c.post_id
    WHERE c.id IS NULL
    ORDER BY p.id
  `);

  return result.rows;
}

/**
 * Get all chunks that need embeddings
 */
export async function getChunksNeedingEmbeddings(limit: number = 100): Promise<Array<{ id: number; content: string }>> {
  if (!pool) return [];

  const result = await pool.query<{ id: number; content: string }>(`
    SELECT id, content
    FROM chunks
    WHERE embedding IS NULL
    ORDER BY id
    LIMIT $1
  `, [limit]);

  return result.rows;
}

/**
 * Update chunk with embedding
 */
export async function updateChunkEmbedding(chunkId: number, embedding: number[]): Promise<void> {
  if (!pool) return;

  const embeddingStr = `[${embedding.join(',')}]`;
  await pool.query(
    `UPDATE chunks SET embedding = $1::vector WHERE id = $2`,
    [embeddingStr, chunkId]
  );
}

/**
 * Search for similar chunks using vector similarity
 */
export async function searchChunks(
  queryEmbedding: number[],
  limit: number = 10,
  source?: string
): Promise<Array<{ id: number; postId: number; content: string; heading: string | null; similarity: number; title: string; url: string }>> {
  if (!pool) return [];

  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  let query = `
    SELECT
      c.id,
      c.post_id as "postId",
      c.content,
      c.heading,
      1 - (c.embedding <=> $1::vector) as similarity,
      p.title,
      p.url
    FROM chunks c
    JOIN posts p ON c.post_id = p.id
    WHERE c.embedding IS NOT NULL
  `;

  const params: any[] = [embeddingStr];

  if (source) {
    query += ` AND p.source = $2`;
    params.push(source);
  }

  query += ` ORDER BY c.embedding <=> $1::vector LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get stats about chunks and embeddings
 */
export async function getChunkStats(): Promise<{ totalChunks: number; withEmbeddings: number; withoutEmbeddings: number }> {
  if (!pool) return { totalChunks: 0, withEmbeddings: 0, withoutEmbeddings: 0 };

  const result = await pool.query<{ total: string; with_embeddings: string; without_embeddings: string }>(`
    SELECT
      COUNT(*) as total,
      COUNT(embedding) as with_embeddings,
      COUNT(*) - COUNT(embedding) as without_embeddings
    FROM chunks
  `);

  const row = result.rows[0];
  return {
    totalChunks: parseInt(row.total, 10),
    withEmbeddings: parseInt(row.with_embeddings, 10),
    withoutEmbeddings: parseInt(row.without_embeddings, 10),
  };
}

/**
 * Get all existing post URLs from the database.
 * Used to skip already-scraped posts for efficiency.
 * Optionally filter by source.
 */
export async function getExistingPostUrls(source?: string): Promise<Set<string>> {
  if (!pool) {
    return new Set();
  }

  if (source) {
    const result = await pool.query<{ url: string }>(
      `SELECT url FROM posts WHERE source = $1`,
      [source]
    );
    return new Set(result.rows.map((row) => row.url));
  }

  const result = await pool.query<{ url: string }>(`SELECT url FROM posts`);
  return new Set(result.rows.map((row) => row.url));
}

export async function upsertPost(post: PostRecord) {
  if (!pool) {
    return;
  }

  const {
    url,
    slug,
    title,
    datePublished,
    doctorSection,
    categories,
    tags,
    markdown,
    source = "paul-chek-blog",
  } = post;

  await pool.query(
    `
    INSERT INTO posts (
      url, slug, title, date_published, doctor_section, categories, tags, markdown, source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (url) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      date_published = EXCLUDED.date_published,
      doctor_section = EXCLUDED.doctor_section,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      markdown = EXCLUDED.markdown,
      source = EXCLUDED.source,
      updated_at = NOW();
  `,
    [
      url,
      slug,
      title,
      datePublished,
      doctorSection,
      categories,
      tags,
      markdown,
      source,
    ]
  );
}
