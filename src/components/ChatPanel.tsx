'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { VideoWithMeta } from '@/types';
import { TimelineRange } from './TimelineRange';
import MarkdownRenderer from './MarkdownRenderer';
import { ShareCard } from './ShareCard';

interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface ChatPanelProps {
  video: VideoWithMeta;
  subtitleSegments: SubtitleSegment[];
  onTimestampClick: (seconds: number) => void;
  currentPlayerSeconds: number;
  playerDuration?: number;
}

export default function ChatPanel({
  video,
  subtitleSegments = [],
  onTimestampClick,
  currentPlayerSeconds,
  playerDuration = 0,
}: ChatPanelProps) {
  const durationInSeconds = useMemo(() => {
    // 1. Priority: Subtitles (most accurate for range selection)
    if (subtitleSegments.length > 0) {
      return subtitleSegments[subtitleSegments.length - 1].end;
    }
    // 2. Secondary: Real-time player duration
    if (playerDuration > 0) {
      return playerDuration;
    }
    // 3. Fallback: Parse duration string from static video metadata
    if (video.duration) {
        const parts = video.duration.split(':').map(Number);
        if (parts.length === 2 && !parts.some(isNaN)) {
            return parts[0] * 60 + parts[1];
        } else if (parts.length === 3 && !parts.some(isNaN)) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
    }
    return 0;
  }, [subtitleSegments, video.duration, playerDuration]);

  const [mode, setMode] = useState<'obsidian' | 'roast'>('obsidian');
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [userPrompt, setUserPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Initialize rangeEnd once duration is known
  useEffect(() => {
    if (durationInSeconds > 0 && rangeEnd === 0) {
      setRangeEnd(durationInSeconds);
    }
  }, [durationInSeconds, rangeEnd]);

  const filteredSegments = useMemo(() => {
    return subtitleSegments.filter(
      (seg) => seg.start >= rangeStart && seg.start < rangeEnd
    );
  }, [subtitleSegments, rangeStart, rangeEnd]);

  const handleGenerate = async () => {
    if (streaming) {
      abortRef.current?.abort();
      setStreaming(false);
      return;
    }

    setStreaming(true);
    setStreamingContent('');
    setError(null);
    
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/videos/${video.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          prompt: userPrompt,
          rangeStart,
          rangeEnd
        }),
        signal: controller.signal
      });

      if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '请求失败');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');

      const decoder = new TextDecoder();
      let full = '';

      while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              
              try {
                  const data = JSON.parse(trimmed.slice(6));
                  if (data.delta) {
                      full += data.delta;
                      setStreamingContent(full);
                  }
                  if (data.error) {
                      throw new Error(data.error);
                  }
                  if (data.done) {
                      break;
                  }
              } catch {
                  // Skip
              }
          }
      }
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            setError(getErrorMessage(error, '请求失败'));
        }
    } finally {
        setStreaming(false);
        abortRef.current = null;
    }
  };

  const roastData = useMemo(() => {
    if (mode !== 'roast' || !streamingContent || streaming) return null;
    
    // Using [\s\S]*? instead of .* and /s flag for better compatibility
    const summaryMatch = streamingContent.match(/## 一句话总结\n+([\s\S]*?)(?=\n##|$)/);
    const quotesMatch = streamingContent.match(/## 关键片段\n+([\s\S]*?)(?=\n##|$)/);
    const commentMatch = streamingContent.match(/## 评论\n+([\s\S]*?)(?=\n##|$)/);

    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    const quotesRaw = quotesMatch ? quotesMatch[1].trim() : '';
    const commentary = commentMatch ? commentMatch[1].trim() : '';

    const quotes: Array<{ timestamp: string; text: string }> = [];
    if (quotesRaw) {
        const lines = quotesRaw.split('\n');
        for (const line of lines) {
            const match = line.match(/^[-*+]\s+「?\[?(\d+:\d+(?::\d+)?)\]?(\(.*\))?」?\s*(.+)$/);
            if (match) {
                quotes.push({ timestamp: match[1], text: match[3] });
            }
        }
    }

    return { summary, quotes, commentary };
  }, [streamingContent, mode, streaming]);

  const handleCopyMarkdown = () => {
    if (!streamingContent) return;
    navigator.clipboard.writeText(streamingContent);
  };

  const handleDownloadMd = () => {
    if (!streamingContent) return;
    const blob = new Blob([streamingContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${video.title.slice(0, 30)}_note.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportPng = async () => {
    if (!cardRef.current) return;
    try {
        const { toPng } = await import('html-to-image');
        const dataUrl = await toPng(cardRef.current, { pixelRatio: 2, quality: 0.95 });
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `${video.title.slice(0, 30)}_roast.png`;
        a.click();
    } catch (error) {
        console.error('Export failed', error);
        alert('导出图片失败: ' + getErrorMessage(error, '未知错误'));
    }
  };

  const handleCopyImage = async () => {
    if (!cardRef.current) return;
    try {
        const { toPng } = await import('html-to-image');
        const dataUrl = await toPng(cardRef.current, { pixelRatio: 2 });
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            alert('图片已复制到剪贴板');
        } else {
            throw new Error('当前浏览器不支持复制图片到剪贴板');
        }
    } catch (error) {
        console.error('Copy failed', error);
        alert('复制图片失败: ' + getErrorMessage(error, '未知错误'));
    }
  };

  // Auto-scroll to bottom of content while streaming
  useEffect(() => {
    if (streaming && scrollEndRef.current) {
        scrollEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingContent, streaming]);

  return (
    <div 
      className="chat-panel" 
      style={{ 
        height: '100%', 
        display: 'flex', 
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <div 
        className="chat-scroll-area"
        style={{ 
          flex: 1, 
          overflowY: 'auto', 
          paddingRight: 4,
          paddingBottom: 'calc(40px + env(safe-area-inset-bottom, 0px))'
        }}
      >
        {/* Mode Switcher */}
        <div style={{ 
          display: 'flex', 
          gap: 8, 
          marginBottom: 16,
          background: 'var(--bg-hover)',
          padding: 4,
          borderRadius: 10,
          width: 'fit-content'
        }}>
          <button 
            onClick={() => { setMode('obsidian'); setStreamingContent(''); }}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 8,
              border: 'none',
              background: mode === 'obsidian' ? 'var(--bg-secondary)' : 'transparent',
              color: mode === 'obsidian' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: mode === 'obsidian' ? 'var(--shadow-sm)' : 'none',
              cursor: 'pointer',
              fontWeight: 600,
              transition: 'all 0.2s'
            }}
          >
            笔记模式
          </button>
          <button 
            onClick={() => { setMode('roast'); setStreamingContent(''); }}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 8,
              border: 'none',
              background: mode === 'roast' ? 'var(--bg-secondary)' : 'transparent',
              color: mode === 'roast' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: mode === 'roast' ? 'var(--shadow-sm)' : 'none',
              cursor: 'pointer',
              fontWeight: 600,
              transition: 'all 0.2s'
            }}
          >
            吐槽模式
          </button>
        </div>

        {/* Section 1: Timeline */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ 
            fontSize: 13, 
            fontWeight: 700, 
            marginBottom: 8, 
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ 
                    width: 20, 
                    height: 20, 
                    borderRadius: '50%', 
                    background: 'var(--accent-purple)', 
                    color: '#fff', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    fontSize: 10
                }}>1</span>
                选择视频范围
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
                <button 
                    onClick={() => { setRangeStart(0); setRangeEnd(durationInSeconds); }}
                    style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}
                >
                    全选
                </button>
                <button 
                    onClick={() => { setRangeStart(currentPlayerSeconds); setRangeEnd(durationInSeconds); }}
                    style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}
                >
                    当前至结尾
                </button>
            </div>
          </div>
          
          <div style={{ 
            background: 'var(--bg-secondary)', 
            borderRadius: 12, 
            padding: '4px 12px',
            border: '1px solid var(--border)'
          }}>
            <TimelineRange
              totalDuration={durationInSeconds}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onRangeChange={(start, end) => {
                setRangeStart(start);
                setRangeEnd(end);
              }}
              onSeek={onTimestampClick}
              currentPlayerSeconds={currentPlayerSeconds}
            />
          </div>
        </div>

        {/* Section 2: Input */}
        <div style={{ marginBottom: 20 }}>
            <div style={{ 
                fontSize: 13, 
                fontWeight: 700, 
                marginBottom: 12, 
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 6
            }}>
                <span style={{ 
                    width: 20, 
                    height: 20, 
                    borderRadius: '50%', 
                    background: 'var(--accent-purple)', 
                    color: '#fff', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    fontSize: 10
                }}>2</span>
                {mode === 'obsidian' ? '你的想法 (笔记重点)' : '你的槽点'}
            </div>

            <div style={{ position: 'relative' }}>
                <textarea 
                    value={userPrompt}
                    onChange={(e) => setUserPrompt(e.target.value)}
                    placeholder={mode === 'obsidian' ? '例如：总结这段关于架构设计的核心观点并举例...' : '例如：这段话也太离谱了，简直是在胡说八道...'}
                    style={{
                        width: '100%',
                        minHeight: 100,
                        padding: '12px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        fontSize: 13,
                        color: 'var(--text-primary)',
                        resize: 'none',
                        outline: 'none',
                        transition: 'border-color 0.2s'
                    }}
                    onFocus={(e) => e.target.style.borderColor = 'var(--accent-purple)'}
                    onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
                />
                
                <button 
                    onClick={handleGenerate}
                    disabled={!userPrompt.trim() && mode === 'roast'}
                    style={{
                        position: 'absolute',
                        right: 12,
                        bottom: 12,
                        padding: '8px 16px',
                        borderRadius: 8,
                        background: 'var(--accent-purple)',
                        color: '#fff',
                        border: 'none',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: (streaming || (!userPrompt.trim() && mode === 'roast')) ? 'default' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        boxShadow: '0 4px 12px rgba(139, 92, 246, 0.3)',
                        opacity: (!userPrompt.trim() && mode === 'roast') ? 0.5 : 1
                    }}
                >
                    {streaming ? (
                        <>
                            <span className="animate-pulse">✦</span> 停止
                        </>
                    ) : (
                        <>
                            <span>✦</span> 生成
                        </>
                    )}
                </button>
            </div>
        </div>

        {/* Section 3: AI Output */}
        {(streamingContent || error || streaming) && (
            <div style={{ marginBottom: 24 }}>
                <div style={{ 
                    fontSize: 12, 
                    fontWeight: 600, 
                    marginBottom: 12, 
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}>
                    AI 生成结果
                    {streaming && <span style={{ fontSize: 10, color: 'var(--accent-purple)', fontWeight: 500 }} className="animate-pulse">正在输入中...</span>}
                </div>

                <div style={{ 
                    background: 'var(--bg-secondary)', 
                    borderRadius: 16, 
                    padding: '20px',
                    border: '1px solid var(--border)',
                    minHeight: 120,
                    position: 'relative',
                    overflowX: 'auto'
                }}>
                    {error && (
                        <div style={{ color: 'var(--destructive)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
                            {error}
                        </div>
                    )}
                    {streamingContent ? (
                        <MarkdownRenderer
                            markdown={streamingContent}
                            video={video}
                            onTimestampClick={onTimestampClick}
                            streaming={streaming}
                            tone="dark"
                        />
                    ) : (
                        !error && streaming && <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>启动中...</div>
                    )}
                    <div ref={scrollEndRef} />
                </div>

                {/* Final Rendered Card for Roast mode */}
                {roastData && (
                    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                         <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)', width: '100%' }}>
                            分享预览
                        </div>
                        <div style={{ 
                            transform: 'scale(0.8)', 
                            transformOrigin: 'top center',
                            height: 'auto',
                            marginBottom: -80, // Compensate for scale
                            width: 'fit-content'
                        }}>
                             <ShareCard
                                video={video}
                                summary={roastData.summary}
                                quotes={roastData.quotes}
                                commentary={roastData.commentary}
                                cardRef={cardRef as React.RefObject<HTMLDivElement>}
                            />
                        </div>
                    </div>
                )}

                {/* Action Bar for results */}
                {!streaming && streamingContent && (
                    <div style={{ 
                        marginTop: 12, 
                        display: 'flex', 
                        gap: 8,
                    }}>
                        {mode === 'obsidian' ? (
                            <>
                                <button 
                                    onClick={handleCopyMarkdown}
                                    style={{
                                        flex: 1,
                                        padding: '10px',
                                        borderRadius: 8,
                                        border: '1px solid var(--border)',
                                        background: 'var(--bg-hover)',
                                        fontSize: 12,
                                        color: 'var(--text-primary)',
                                        cursor: 'pointer',
                                        fontWeight: 600
                                    }}
                                >
                                    复制 Markdown
                                </button>
                                <button 
                                    onClick={handleDownloadMd}
                                    style={{
                                        flex: 1,
                                        padding: '10px',
                                        borderRadius: 8,
                                        border: '1px solid var(--border)',
                                        background: 'var(--bg-hover)',
                                        fontSize: 12,
                                        color: 'var(--text-primary)',
                                        cursor: 'pointer',
                                        fontWeight: 600
                                    }}
                                >
                                    下载 .md
                                </button>
                            </>
                        ) : (
                            roastData && (
                                <>
                                    <button 
                                        onClick={handleExportPng}
                                        style={{
                                            flex: 1,
                                            padding: '10px',
                                            borderRadius: 8,
                                            border: '1px solid var(--border)',
                                            background: 'var(--bg-hover)',
                                            fontSize: 12,
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            fontWeight: 600
                                        }}
                                    >
                                        下载分享图
                                    </button>
                                    <button 
                                        onClick={handleCopyImage}
                                        style={{
                                            flex: 1,
                                            padding: '10px',
                                            borderRadius: 8,
                                            border: '1px solid var(--border)',
                                            background: 'var(--bg-hover)',
                                            fontSize: 12,
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            fontWeight: 600
                                        }}
                                    >
                                        复制分享图
                                    </button>
                                </>
                            )
                        )}
                    </div>
                )}
            </div>
        )}
        
        {/* Section 4: Subtitle Preview */}
        {!streamingContent && (
            <>
                <div style={{ 
                    fontSize: 12, 
                    fontWeight: 600, 
                    marginBottom: 8, 
                    color: 'var(--text-secondary)',
                    marginTop: 8
                }}>
                    选中字幕预览 ({filteredSegments.length})
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.8 }}>
                    {filteredSegments.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                            当前范围无字幕
                        </div>
                    ) : (
                        filteredSegments.slice(0, 10).map((seg, i) => (
                            <div key={i} style={{ 
                                fontSize: 11, 
                                background: 'var(--bg-secondary)', 
                                padding: '6px 10px', 
                                borderRadius: 6,
                                border: '1px solid var(--border-subtle)',
                                lineHeight: 1.5
                            }}>
                                <span style={{ 
                                    color: 'var(--accent-purple)', 
                                    fontFamily: 'var(--font-mono, monospace)', 
                                    marginRight: 8,
                                    fontWeight: 600
                                }}>
                                    [{Math.floor(seg.start / 60)}:{Math.floor(seg.start % 60).toString().padStart(2, '0')}]
                                </span> 
                                {seg.text}
                            </div>
                        ))
                    )}
                    {filteredSegments.length > 10 && (
                        <div style={{ fontSize: 10, textAlign: 'center', color: 'var(--text-muted)', padding: '4px 0' }}>
                            ... 其余 {filteredSegments.length - 10} 段未显示 ...
                        </div>
                    )}
                </div>
            </>
        )}
      </div>
    </div>
  );
}
