'use client';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * 从设备读文件列表时的占位卡片；形状照着 `MediaCard` 来，切换时不跳版。
 *
 * 宽高比同样由调用方按当前设备的画布尺寸给（`aspect`），不写死某一块板的比例。
 */
export function LibrarySkeleton({
  count = 3,
  aspect,
}: {
  count?: number;
  /** CSS aspect-ratio 值，例如 `312 / 164`；不传就用 16/9 */
  aspect?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="overflow-hidden rounded-xl border">
          <Skeleton className="w-full rounded-none" style={{ aspectRatio: aspect ?? '16 / 9' }} />
          <div className="flex flex-wrap items-center gap-1 border-t p-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="ml-auto h-7 w-14" />
          </div>
          <div className="px-2 pt-1 pb-2">
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}
