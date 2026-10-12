'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatEntryLine, localDay, type DayManifest, type DeviceLog, type LogEntry } from '@/lib/device-log';
import { bytesLabel, saveBytesAs } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 实时视图最多保留多少行（更早的按天看/下载） */
const MAX_ROWS = 2000;
/** 实时追加攒多久刷一次界面：上传时一秒上千条 ACK，逐条 setState 会把页面卡住 */
const LIVE_FLUSH_MS = 200;

type Filter = 'all' | 'fw' | 'commands';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'fw', label: '固件' },
  { value: 'commands', label: '命令' },
];

function matchesFilter(entry: LogEntry, filter: Filter): boolean {
  if (filter === 'fw') return entry.kind === 'frame';
  if (filter === 'commands') return entry.dir === 'tx' || entry.dir === 'rx';
  return true;
}

/** 一行日志的配色：按来源分色，扫一眼就能分清"谁在说话" */
function toneOf(entry: LogEntry): string {
  if (entry.kind === 'error') return 'text-destructive';
  if (entry.kind === 'frame') return 'text-amber-600 dark:text-amber-400';
  if (entry.dir === 'note') return 'text-muted-foreground';
  return entry.dir === 'tx' ? 'text-sky-700 dark:text-sky-400' : 'text-emerald-700 dark:text-emerald-400';
}

/** 追加一条实时日志；`seq` 相同的是"合并中的那一条"（ACK ×N），原地更新 */
function appendRow(rows: LogEntry[], entry: LogEntry): void {
  const last = rows[rows.length - 1];
  if (last && last.seq !== undefined && last.seq === entry.seq) {
    rows[rows.length - 1] = entry;
    return;
  }
  rows.push(entry);
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
}

interface Props {
  logs: DeviceLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeviceLogDialog({ logs, open, onOpenChange }: Props) {
  const [days, setDays] = useState<DayManifest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [follow, setFollow] = useState(true);
  const [version, bumpRows] = useReducer((n: number) => n + 1, 0);

  /** 当前这一天读进来的全部记录（上限 MAX_ROWS），过滤只作用在视图上 */
  const allRef = useRef<LogEntry[]>([]);
  const rowsRef = useRef<LogEntry[]>([]);
  const pendingRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const filterRef = useRef<Filter>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  selectedRef.current = selected;
  filterRef.current = filter;

  /** 过滤只重排视图，不动已经读进来/实时收到的那一份 */
  const applyFilter = useCallback(() => {
    rowsRef.current = allRef.current.filter((entry) => matchesFilter(entry, filterRef.current));
    bumpRows();
  }, []);

  const loadDay = useCallback(
    async (day: string | null) => {
      if (!logs || !day) {
        allRef.current = [];
        rowsRef.current = [];
            bumpRows();
        return;
      }
      setLoading(true);
      try {
        const all = await logs.readDay(day);
        allRef.current = all.slice(-MAX_ROWS);
        // 帧数按**整天**算（和当前过滤无关）：导出走 `logs.exportTxt`，界面上切档不该影响它
        applyFilter();
      } finally {
        setLoading(false);
      }
    },
    [applyFilter, logs],
  );

  // 打开时刷新"有哪几天"，默认选今天（没有今天就选最近的一天）
  useEffect(() => {
    if (!open || !logs) return;
    const list = logs.listDays();
    setDays(list);
    setSelected((current) => current ?? list[0]?.day ?? localDay(Date.now()));
    setFollow(true);
  }, [open, logs]);

  // 换天：从 IndexedDB 读那一整天
  useEffect(() => {
    if (!open) return;
    void loadDay(selected);
  }, [open, selected, loadDay]);

  // 换过滤档：不重新读卡，只重排已经拿到的记录（这样实时收到的那些不会被丢掉）
  useEffect(() => {
    if (!open) return;
    applyFilter();
  }, [open, filter, applyFilter]);

  // 实时跟随：订阅新条目 + 定时刷界面；顺便盯着"每天清单"的变化
  useEffect(() => {
    if (!open || !logs) return;
    return logs.subscribe((event) => {
      if (event.type === 'days') {
        setDays(logs.listDays());
        return;
      }
      const entry = event.entry;
      if (entry.day !== selectedRef.current) return;
      appendRow(allRef.current, entry);
      if (matchesFilter(entry, filterRef.current)) appendRow(rowsRef.current, entry);
      // 帧从不合并，所以每条都是新的
      pendingRef.current = true;
    });
  }, [open, logs]);

  // 整天加载那一轮别和实时追加抢：每次 bump 都重新渲染当前 rowsRef
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      bumpRows();
    }, LIVE_FLUSH_MS);
    return () => window.clearInterval(timer);
  }, [open]);

  // 自动滚到底；用户往上翻就等于"暂停跟随"
  useEffect(() => {
    if (!follow) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, version, selected]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
  };

  const downloadText = async () => {
    if (!logs || !selected) return;
    const text = await logs.exportTxt(selected);
    saveBytesAs(`pet-board-log-${selected}.txt`, new TextEncoder().encode(text));
  };

  const clear = async () => {
    if (!logs) return;
    if (!window.confirm('确定清空所有设备日志吗？这个操作不能撤销。')) return;
    await logs.clear();
    allRef.current = [];
    rowsRef.current = [];
    setDays(logs.listDays());
    bumpRows();
  };

  const rows = rowsRef.current;
  const stats = logs?.stats() ?? { days: 0, bytes: 0, count: 0 };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-full flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>设备日志</DialogTitle>
        </DialogHeader>

        {!logs ? (
          <p className="text-muted-foreground py-10 text-center text-sm">
            本机打不开日志库（浏览器没有 IndexedDB，或处于隐私模式）。
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
            {/* 左边：按天列表 */}
            <aside className="flex min-h-0 shrink-0 flex-col gap-1 sm:w-40">
              {/* p-1：按钮按下时自带 1px 下移（`active:translate-y-px`），没有这点余量的话
                  滚动容器会因为那 1px 冒出滚动条 */}
              <div className="flex max-h-32 flex-row gap-1 overflow-auto sm:max-h-none sm:min-h-0 sm:flex-1 sm:flex-col">
                {days.length === 0 ? (
                  <p className="text-muted-foreground p-2 text-xs">还没有日志</p>
                ) : (
                  days.map((day) => (
                    <Button
                      key={day.day}
                      size="sm"
                      variant={day.day === selected ? 'secondary' : 'ghost'}
                      className="h-auto shrink-0 flex-col items-start gap-0 px-2 py-1 text-left"
                      onClick={() => {
                        setSelected(day.day);
                        setFollow(true);
                      }}
                    >
                      <span className="font-mono text-xs">{day.day === localDay(Date.now()) ? '今天' : day.day}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {day.count} 条 · {bytesLabel(day.bytes)}
                      </span>
                    </Button>
                  ))
                )}
              </div>
            </aside>

            {/* 右边：日志正文 */}
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-1">
                {FILTERS.map((item) => (
                  <Button
                    key={item.value}
                    size="sm"
                    variant={filter === item.value ? 'secondary' : 'ghost'}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </Button>
                ))}
                {!follow ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => {
                      setFollow(true);
                      const node = scrollRef.current;
                      if (node) node.scrollTop = node.scrollHeight;
                    }}
                  >
                    回到最新
                  </Button>
                ) : null}
              </div>
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="bg-muted/40 min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed"
              >
                {loading && rows.length === 0 ? (
                  <p className="text-muted-foreground">读取中…</p>
                ) : rows.length === 0 ? (
                  <p className="text-muted-foreground">
                    {days.length === 0 ? '还没有日志：连上设备后会自动记录。' : '这一天没有（符合当前过滤的）记录。'}
                  </p>
                ) : (
                  rows.map((entry, index) => (
                    <div key={entry.seq ?? `${entry.id ?? index}`} className={cn('whitespace-pre-wrap break-all', toneOf(entry))}>
                      {formatEntryLine(entry)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button variant="destructive" onClick={() => void clear()} disabled={!logs || stats.count === 0}>
            清空日志
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void downloadText()}
              disabled={!logs || !selected}
              title="协议行逐条记录 + 固件帧的完整十六进制（.txt）—— 命令发出去了没有、回来的是什么、哪一步超时，都在这里"
            >
              下载日志
            </Button>
            <Button onClick={() => onOpenChange(false)}>关闭</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
