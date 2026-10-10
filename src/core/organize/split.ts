/**
 * 批量 AI 调用的自适应降级：整批失败时对半拆分重试，
 * 逐层缩小到 minBatch；最小粒度仍失败的条目交给 onSkipped，任务继续。
 * （解析失败同样受益：更小的输入更不容易让模型输出跑偏）
 */
export async function runWithSplit<T>(
  items: T[],
  runBatch: (slice: T[]) => Promise<void>,
  opts: { minBatch?: number; onSkipped?: (slice: T[]) => void } = {},
): Promise<void> {
  const minBatch = opts.minBatch ?? 5;
  if (!items.length) return;
  try {
    await runBatch(items);
  } catch (e) {
    if (items.length <= minBatch) {
      console.warn('[autobookmark] 批量已到最小粒度，跳过', items.length, '条:', (e as Error).message);
      opts.onSkipped?.(items);
      return;
    }
    console.warn('[autobookmark] 批量失败，对半拆分重试:', (e as Error).message);
    const mid = Math.ceil(items.length / 2);
    await runWithSplit(items.slice(0, mid), runBatch, opts);
    await runWithSplit(items.slice(mid), runBatch, opts);
  }
}
