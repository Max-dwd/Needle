'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { buildChannelUrl } from '@/lib/url-utils';
import UnifiedImportModal from '@/components/UnifiedImportModal';

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface Channel {
  id: number;
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string;
  avatar_url: string;
  intent: string;
  topics: string[];
  description?: string;
  video_count: number;
  created_at: string;
}

interface Intent {
  id: number;
  name: string;
  auto_subtitle: number;
  auto_summary: number;
  sort_order: number;
}

/* ─── Constants ─────────────────────────────────────────────────────────── */

type SortKey = 'video_count' | 'name' | 'created_at';
type SortDir = 'asc' | 'desc';

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'video_count', label: '视频数' },
  { key: 'name', label: '名称' },
  { key: 'created_at', label: '订阅时间' },
];

/* ─── Sub-components ────────────────────────────────────────────────────── */

function PlatformIcon({ platform }: { platform: 'youtube' | 'bilibili' }) {
  if (platform === 'youtube') {
    return (
      <span title="YouTube" style={{ color: 'var(--accent-yt)', fontSize: 12 }}>
        ▶
      </span>
    );
  }
  return (
    <span title="B站" style={{ color: 'var(--accent-bili)', fontSize: 12 }}>
      🅱
    </span>
  );
}

function TopicChip({
  topic,
  onRemove,
}: {
  topic: string;
  onRemove: (t: string) => void;
}) {
  return (
    <span
      className="group"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 8px',
        borderRadius: 99,
        background: 'rgba(139, 92, 246, 0.05)',
        border: '1px solid rgba(139, 92, 246, 0.1)',
        fontSize: 11,
        color: 'var(--accent-purple)',
        transition: 'all 0.15s',
      }}
    >
      {topic}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(topic);
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--accent-purple)',
          opacity: 0.5,
          fontSize: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
        title={`移除「${topic}」`}
      >
        ✕
      </button>
    </span>
  );
}


function TopicInput({
  topics,
  allTopics,
  onAdd,
  onRemove,
}: {
  topics: string[];
  allTopics: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
}) {
  const [val, setVal] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    if (!val.trim()) return [];
    const lower = val.toLowerCase();
    return allTopics.filter(
      (t) => t.toLowerCase().includes(lower) && !topics.includes(t),
    );
  }, [val, allTopics, topics]);

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed && !topics.includes(trimmed)) {
      onAdd(trimmed);
    }
    setVal('');
    setShowInput(false);
    setShowPrompt(false);
  };

  useEffect(() => {
    if (showInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showInput]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
      {topics.map((t) => (
        <TopicChip key={t} topic={t} onRemove={onRemove} />
      ))}
      
      {!showInput && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowInput(true);
          }}
          style={{
            background: 'none',
            border: '1px dashed var(--border)',
            borderRadius: 99,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 0,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-purple)';
            e.currentTarget.style.color = 'var(--accent-purple)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
          title="添加主题"
        >
          +
        </button>
      )}

      {showInput && (
        <div style={{ position: 'relative' }}>
          <input
            ref={inputRef}
            type="text"
            value={val}
            placeholder="..."
            onChange={(e) => {
              setVal(e.target.value);
              setShowPrompt(true);
            }}
            onBlur={() => {
              if (!val.trim()) {
                setShowInput(false);
                setShowPrompt(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                setVal('');
                setShowInput(false);
                setShowPrompt(false);
              }
            }}
            style={{
              border: 'none',
              borderBottom: '1px solid var(--accent-purple)',
              outline: 'none',
              background: 'transparent',
              fontSize: 11,
              color: 'var(--text-primary)',
              width: 60,
              minWidth: 20,
              padding: '0 2px',
            }}
          />
          {showPrompt && suggestions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 300,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-md)',
                minWidth: 120,
                maxWidth: 200,
              }}
            >
              {suggestions.slice(0, 6).map((s) => (
                <div
                  key={s}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!topics.includes(s)) onAdd(s);
                    setVal('');
                    setShowInput(false);
                    setShowPrompt(false);
                  }}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.background = 'var(--bg-hover)';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.background = 'transparent';
                  }}
                >
                  {s}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function IntentDropdown({
  currentIntent,
  intents,
  onChange,
}: {
  currentIntent: string;
  intents: Intent[];
  onChange: (intent: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandUp, setExpandUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const dropHeight = intents.length * 32 + 10; // estimate
      const spaceBelow = window.innerHeight - rect.bottom;
      setExpandUp(spaceBelow < dropHeight);
    }
  }, [open, intents.length]);

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
        title="修改意图"
      >
        {currentIntent}
        <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
      </button>
      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              ...(expandUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
              left: 0,
              zIndex: 200,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-md)',
              minWidth: 100,
            }}
          >
            {intents.map((intent) => (
              <div
                key={intent.id}
                onClick={() => {
                  onChange(intent.name);
                  setOpen(false);
                }}
                style={{
                  padding: '7px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  background:
                    intent.name === currentIntent
                      ? 'var(--bg-hover)'
                      : 'transparent',
                  color:
                    intent.name === currentIntent
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  (e.target as HTMLElement).style.background = 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => {
                  if (intent.name !== currentIntent)
                    (e.target as HTMLElement).style.background = 'transparent';
                }}
              >
                {intent.name}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


function ChannelCard({
  channel,
  intents,
  allTopics,
  selected,
  onToggle,
  onIntentChange,
  onTopicsChange,
  onDelete,
  onDragStart,
  onDragEnd,
  isCompact = false,
}: {
  channel: Channel;
  intents: Intent[];
  allTopics: string[];
  selected: boolean;
  onToggle: (id: number) => void;
  onIntentChange: (id: number, intent: string) => void;
  onTopicsChange: (id: number, topics: string[]) => void;
  onDelete: (id: number, name: string) => void;
  onDragStart: (e: React.DragEvent, id: number) => void;
  onDragEnd: () => void;
  isCompact?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      className={`channel-card ${isCompact ? 'compact' : ''}`}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        setIsDragging(true);
        onDragStart(e, channel.id);
      }}
      onDragEnd={() => {
        setIsDragging(false);
        onDragEnd();
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onToggle(channel.id)}
      title={channel.description || channel.name}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: isCompact ? '10px 8px' : '16px 12px',
        borderRadius: 'var(--radius-lg)',
        background: selected ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)',
        border: `2px solid ${selected ? 'var(--accent-purple)' : isHovered ? 'var(--border)' : 'transparent'}`,
        boxShadow: isHovered ? 'var(--shadow-md)' : 'none',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        cursor: 'pointer',
        position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        userSelect: 'none',
        textAlign: 'center',
        minWidth: 0,
        gap: isCompact ? 8 : 12,
      }}
    >
      {/* Checkbox badge */}
      <div
        className="checkbox"
        style={{
          position: 'absolute',
          top: isCompact ? 6 : 10,
          left: isCompact ? 6 : 10,
          width: isCompact ? 14 : 18,
          height: isCompact ? 14 : 18,
          borderRadius: isCompact ? 4 : 6,
          border: `2px solid ${selected ? 'var(--accent-purple)' : 'var(--border)'}`,
          background: selected ? 'var(--accent-purple)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: isCompact ? 9 : 11,
          color: '#fff',
          fontWeight: 700,
          transition: 'all 0.15s',
          zIndex: 10,
        }}
      >
        {selected ? '✓' : ''}
      </div>

      {/* Delete button (hidden by default) */}
      {!isCompact && (
        <button
          className="btn-danger btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(channel.id, channel.name || channel.channel_id);
          }}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            padding: 0,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.2s',
            zIndex: 10,
            fontSize: 10,
            background: 'rgba(255, 61, 61, 0.1)',
            border: 'none',
          }}
          title="取消订阅"
        >
          ✕
        </button>
      )}

      {/* Avatar */}
      <a
        href={buildChannelUrl(channel.platform, channel.channel_id)}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', position: 'relative' }}
      >
        <div className="avatar" style={{ position: 'relative', width: isCompact ? 40 : 64, height: isCompact ? 40 : 64 }}>
          {channel.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={channel.avatar_url}
              alt={channel.name}
              referrerPolicy="no-referrer"
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '2px solid var(--border-subtle)',
                background: 'var(--bg-hover)',
              }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'var(--bg-hover)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: isCompact ? 16 : 24,
              }}
            >
              <PlatformIcon platform={channel.platform} />
            </div>
          )}
          <div 
            className="platform-badge"
            style={{ 
              position: 'absolute', 
              bottom: 0, 
              right: 0, 
              background: 'var(--bg-card)', 
              borderRadius: '50%', 
              padding: isCompact ? 1 : 2,
              display: 'flex',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
              transform: isCompact ? 'scale(0.8)' : 'none',
              transformOrigin: 'bottom right'
            }}
          >
            <PlatformIcon platform={channel.platform} />
          </div>
        </div>
      </a>

      {/* Info */}
      <div style={{ width: '100%', minWidth: 0 }}>
        <div
          className="name"
          style={{
            fontWeight: 700,
            fontSize: isCompact ? 12 : 14,
            marginBottom: isCompact ? 0 : 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
          }}
          title={channel.name || channel.channel_id}
        >
          {channel.name || channel.channel_id}
        </div>
        {!isCompact && (
          <div
            className="meta"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--text-muted)',
              flexWrap: 'wrap',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span>{channel.video_count} 个视频</span>
            <span style={{ opacity: 0.5 }}>-</span>
            <IntentDropdown
              currentIntent={channel.intent}
              intents={intents}
              onChange={(intent) => onIntentChange(channel.id, intent)}
            />
            <span style={{ opacity: 0.5 }}>-</span>
            <TopicInput
              topics={channel.topics}
              allTopics={allTopics}
              onAdd={(t) => onTopicsChange(channel.id, [...channel.topics, t])}
              onRemove={(t) =>
                onTopicsChange(
                  channel.id,
                  channel.topics.filter((x) => x !== t),
                )
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
function GroupHeader({
  intentName,
  channelCount,
  allSelected,
  onToggleAll,
  onDrop,
}: {
  intentName: string;
  channelCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onDrop: (intentName: string) => void;
}) {
  const [isOver, setIsOver] = useState(false);

  return (
    <div
      className="group-header"
      onDragOver={(e) => {
        e.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        onDrop(intentName);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 16,
        marginTop: 32,
        padding: '12px 16px',
        borderRadius: 'var(--radius-lg)',
        background: isOver ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
        border: `2px dashed ${isOver ? 'var(--accent-purple)' : 'transparent'}`,
        transition: 'all 0.2s',
      }}
    >
      <h3
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: 'var(--text-primary)',
          margin: 0,
          letterSpacing: '-0.02em'
        }}
      >
        {intentName}
      </h3>
      <div className="group-header-line" />
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--accent-purple)',
          background: 'rgba(139, 92, 246, 0.1)',
          padding: '2px 10px',
          borderRadius: 99,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {channelCount}
      </span>
      {isOver && (
        <span style={{ fontSize: 12, color: 'var(--accent-purple)', fontWeight: 500 }}>
          松开以移动到此组
        </span>
      )}
      <button
        onClick={onToggleAll}
        style={{
          marginLeft: 'auto',
          fontSize: 12,
          color: 'var(--text-secondary)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '4px 12px',
          cursor: 'pointer',
          fontWeight: 500,
          transition: 'all 0.2s',
        }}
      >
        {allSelected ? '取消全选' : '全选本组'}
      </button>
    </div>
  );
}


function BatchOpsBar({
  selectedCount,
  intents,
  allTopics,
  onSetIntent,
  onAddTopics,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  intents: Intent[];
  allTopics: string[];
  onSetIntent: (intent: string) => void;
  onAddTopics: (topics: string[]) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [intentPickerOpen, setIntentPickerOpen] = useState(false);
  const [topicInputVal, setTopicInputVal] = useState('');
  const [topicSuggestions, setTopicSuggestions] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: 'rgba(15, 15, 20, 0.9)',
        backdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: 24,
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)',
        color: '#fff',
        animation: 'floatUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <style>
        {`
          @keyframes floatUp {
            from { transform: translate(-50%, 40px); opacity: 0; }
            to { transform: translate(-50%, 0); opacity: 1; }
          }
        `}
      </style>

      {/* Selection info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRight: '1px solid rgba(255, 255, 255, 0.1)', paddingRight: 20 }}>
        <div 
          style={{ 
            background: 'var(--accent-purple)', 
            color: '#fff',
            width: 24,
            height: 24,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700
          }}
        >
          {selectedCount}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>已选择</span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {/* 设置意图 */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setIntentPickerOpen((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255, 255, 255, 0.8)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 12,
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            <span>🎯 修改意图</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>{intentPickerOpen ? '▴' : '▾'}</span>
          </button>
          
          {intentPickerOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 1100 }}
                onClick={() => setIntentPickerOpen(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 12px)',
                  left: 0,
                  zIndex: 1101,
                  background: 'rgba(30, 30, 35, 0.95)',
                  backdropFilter: 'blur(10px)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: 16,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                  minWidth: 140,
                  overflow: 'hidden',
                  padding: 4,
                }}
              >
                {intents.map((i) => (
                  <div
                    key={i.id}
                    onClick={() => {
                      onSetIntent(i.name);
                      setIntentPickerOpen(false);
                    }}
                    style={{
                      padding: '10px 14px',
                      fontSize: 13,
                      cursor: 'pointer',
                      borderRadius: 10,
                      transition: 'all 0.15s'
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'rgba(139, 92, 246, 0.2)';
                      (e.currentTarget as HTMLElement).style.color = '#fff';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'transparent';
                      (e.currentTarget as HTMLElement).style.color = 'rgba(255, 255, 255, 0.8)';
                    }}
                  >
                    {i.name}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 添加主题 */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            background: 'rgba(255, 255, 255, 0.05)', 
            borderRadius: 12, 
            padding: '2px 8px 2px 12px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <span style={{ fontSize: 13, marginRight: 8, opacity: 0.8 }}>🏷️</span>
            <input
              type="text"
              placeholder="批量贴标…"
              value={topicInputVal}
              onChange={(e) => {
                const v = e.target.value;
                setTopicInputVal(v);
                if (v.trim()) {
                  const lower = v.toLowerCase();
                  setTopicSuggestions(
                    allTopics.filter(
                      (t) => t.toLowerCase().includes(lower) && !selectedTopics.includes(t),
                    ),
                  );
                } else {
                  setTopicSuggestions([]);
                }
              }}
              onFocus={() => {
                if (topicInputVal.trim()) setTopicSuggestions(allTopics.filter(t => t.toLowerCase().includes(topicInputVal.toLowerCase()) && !selectedTopics.includes(t)));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const t = topicInputVal.trim();
                  if (t && !selectedTopics.includes(t)) {
                    setSelectedTopics((prev) => [...prev, t]);
                    setTopicInputVal('');
                    setTopicSuggestions([]);
                  }
                }
              }}
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: '#fff',
                fontSize: 13,
                width: 100,
                padding: '6px 0',
              }}
            />
            {selectedTopics.length > 0 && (
              <button
                onClick={() => {
                  onAddTopics(selectedTopics);
                  setSelectedTopics([]);
                }}
                style={{
                  background: 'var(--accent-purple)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  marginLeft: 8
                }}
              >
                应用
              </button>
            )}
          </div>
          
          {topicSuggestions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 12px)',
                left: 0,
                zIndex: 1101,
                background: 'rgba(30, 30, 35, 0.95)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: 16,
                boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                minWidth: 140,
                padding: 4,
              }}
            >
              {topicSuggestions.slice(0, 5).map((s) => (
                <div
                  key={s}
                  onClick={() => {
                    if (!selectedTopics.includes(s)) setSelectedTopics((prev) => [...prev, s]);
                    setTopicInputVal('');
                    setTopicSuggestions([]);
                  }}
                  style={{
                    padding: '10px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                    borderRadius: 10
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(139, 92, 246, 0.2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {s}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 批量删除 */}
        <button
          onClick={onDelete}
          style={{
            background: 'rgba(255, 61, 61, 0.1)',
            border: '1px solid rgba(255, 61, 61, 0.2)',
            color: '#ff5c5c',
            borderRadius: 12,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 61, 61, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255, 61, 61, 0.1)';
          }}
        >
          🗑️ 批量删除
        </button>
      </div>

      <button
        onClick={onClear}
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255, 255, 255, 0.4)',
          fontSize: 20,
          cursor: 'pointer',
          padding: 4,
          display: 'flex',
          marginLeft: 4,
          transition: 'color 0.2s'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255, 255, 255, 0.4)')}
        title="取消选择"
      >
        ✕
      </button>
    </div>
  );
}


/* ─── Main Page ─────────────────────────────────────────────────────────── */

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [hasCookiesBrowser, setHasCookiesBrowser] = useState(false);

  // Filters & sort
  const [searchQuery, setSearchQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState<'all' | 'youtube' | 'bilibili'>('all');
  const [intentFilter, setIntentFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('video_count');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Modals
  const [showUnifiedImport, setShowUnifiedImport] = useState(false);
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importMarkdown, setImportMarkdown] = useState('');
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadChannels = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/channels');
      setChannels(await res.json());
    } catch {
      showToast('加载频道失败', 'error');
    }
  }, [showToast]);

  const loadIntents = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/settings/intents');
      setIntents(await res.json());
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void Promise.all([loadChannels(), loadIntents()]).finally(() => setLoading(false));
  }, [loadChannels, loadIntents]);

  useEffect(() => {
    fetch('/api/subscriptions/youtube?config=1', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('config failed');
        const data = await res.json();
        setHasCookiesBrowser(Boolean(data.hasCookiesBrowser));
      })
      .catch(() => setHasCookiesBrowser(false));
  }, []);

  // All unique topics across channels
  const allTopics = useMemo(() => {
    const set = new Set<string>();
    channels.forEach((ch) => ch.topics.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [channels]);

  // Filtered + sorted channels
  const filteredChannels = useMemo(() => {
    let list = [...channels];

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (ch) =>
          (ch.name || '').toLowerCase().includes(q) ||
          ch.channel_id.toLowerCase().includes(q),
      );
    }

    // Platform filter
    if (platformFilter !== 'all') {
      list = list.filter((ch) => ch.platform === platformFilter);
    }

    // Intent filter
    if (intentFilter !== 'all') {
      list = list.filter((ch) => ch.intent === intentFilter);
    }

    // Sort
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'video_count') {
        cmp = a.video_count - b.video_count;
      } else if (sortKey === 'name') {
        cmp = (a.name || a.channel_id).localeCompare(b.name || b.channel_id);
      } else if (sortKey === 'created_at') {
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [channels, searchQuery, platformFilter, intentFilter, sortKey, sortDir]);

  // Group by intent
  const groupedChannels = useMemo(() => {
    // Build set of valid intent names from the intents table
    const validIntentNames = new Set(intents.map((i) => i.name));

    // Normalize channel intents: orphaned intents → '未分类'
    const normalizedChannels = filteredChannels.map((ch) => {
      if (validIntentNames.has(ch.intent)) {
        return ch;
      }
      // Orphaned intent — normalize to '未分类'
      return { ...ch, intent: '未分类' };
    });

    const sortedIntents = [...intents].sort((a, b) => {
      if (a.name === '未分类') return 1;
      if (b.name === '未分类') return -1;
      return a.sort_order - b.sort_order;
    });

    const groups: Array<{
      intent: Intent;
      channels: Channel[];
    }> = [];

    for (const intent of sortedIntents) {
      const groupChannels = normalizedChannels.filter((ch) => ch.intent === intent.name);
      if (groupChannels.length > 0) {
        groups.push({ intent, channels: groupChannels });
      }
    }

    return groups;
  }, [filteredChannels, intents]);

  // Toggle sort
  const handleSortToggle = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'video_count' ? 'desc' : 'asc');
    }
  };

  // Individual operations
  const handleIntentChange = async (id: number, intent: string) => {
    // 1. Save original state
    const originalChannels = [...channels];
    
    // 2. Optimistic update
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, intent } : ch));
    
    try {
      const res = await fetch(`/api/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '更新失败', 'error');
        // 3. Rollback on failure
        setChannels(originalChannels);
        return;
      }
      
      // Successfully updated on server
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('更新失败', 'error');
      // 3. Rollback on failure
      setChannels(originalChannels);
    }
  };

  const handleDropToIntent = async (dragId: number | null, targetIntent: string) => {
    const dragIdsStr = localStorage.getItem('drag-channel-ids');
    const dragAccountsStr = localStorage.getItem('drag-accounts-info');

    if (dragIdsStr) {
      try {
        const ids = JSON.parse(dragIdsStr) as number[];
        // We'll use a modified handleBatchSetIntent or manually update them
        await handleBatchSetIntentByIds(ids, targetIntent);
        localStorage.removeItem('drag-channel-ids');
        return;
      } catch (e) { console.error(e); }
    }

    if (dragAccountsStr) {
      try {
        const accounts = JSON.parse(dragAccountsStr);
        await handleBatchImportWithIntent(accounts, targetIntent);
        localStorage.removeItem('drag-accounts-info');
        return;
      } catch (e) { console.error(e); }
    }

    if (dragId !== null) {
      if (selectedIds.has(dragId)) {
        await handleBatchSetIntent(targetIntent);
      } else {
        await handleIntentChange(dragId, targetIntent);
      }
    } else {
      const infoStr = localStorage.getItem('drag-account-info');
      if (infoStr) {
        try {
          const info = JSON.parse(infoStr);
          await handleImportAccountWithIntent(info, targetIntent);
          localStorage.removeItem('drag-account-info');
        } catch (e) {
          console.error('Failed to parse drag-account-info', e);
        }
      }
    }
  };

  const handleBatchSetIntentByIds = async (ids: number[], intent: string) => {
    const originalChannels = [...channels];
    setChannels(prev => prev.map(ch => ids.includes(ch.id) ? { ...ch, intent } : ch));
    try {
      const res = await fetch('/api/channels/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, intent }),
      });
      if (!res.ok) {
        setChannels(originalChannels);
        showToast('批量设置失败', 'error');
        return;
      }
      showToast(`已将 ${ids.length} 个项目移至 ${intent}`);
      clearSelection();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      setChannels(originalChannels);
      showToast('设置失败', 'error');
    }
  };

  const handleBatchImportWithIntent = async (accounts: any[], intent: string) => {
    try {
      const res = await fetch('/api/subscriptions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          channels: accounts,
          targetIntent: intent
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '批量导入失败', 'error');
        return;
      }
      const data = await res.json();
      showToast(`成功导入 ${data.created} 个频道并归类至 ${intent}`);
      await loadChannels();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('导入失败', 'error');
    }
  };

  const handleImportAccountWithIntent = async (info: any, intent: string) => {
    try {
      const res = await fetch('/api/subscriptions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          channels: [{
            platform: info.platform,
            channel_id: info.channel_id,
            name: info.name,
            avatar_url: info.avatar_url || '',
          }],
          targetIntent: intent
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '导入失败', 'error');
        return;
      }
      showToast(`已导入并归类至 ${intent}`);
      await loadChannels();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('导入失败', 'error');
    }
  };

  const handleTopicsChange = async (id: number, topics: string[]) => {
    const originalChannels = [...channels];
    
    // Optimistic update
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, topics } : ch));
    
    try {
      const res = await fetch(`/api/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topics }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '更新失败', 'error');
        setChannels(originalChannels);
        return;
      }
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('更新失败', 'error');
      setChannels(originalChannels);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`确定要取消订阅「${name}」吗？`)) return;
    try {
      await fetch(`/api/channels/${id}`, { method: 'DELETE' });
      showToast('已取消订阅');
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await loadChannels();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('操作失败', 'error');
    }
  };

  // Selection
  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (intentName: string, channelIds: number[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = channelIds.every((id) => prev.has(id));
      if (allSelected) {
        channelIds.forEach((id) => next.delete(id));
      } else {
        channelIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  // Batch intent
  const handleBatchSetIntent = async (intent: string) => {
    if (selectedIds.size === 0) return;
    const originalChannels = [...channels];
    const ids = Array.from(selectedIds);
    
    // Optimistic update
    setChannels(prev => prev.map(ch => ids.includes(ch.id) ? { ...ch, intent } : ch));
    
    try {
      const res = await fetch('/api/channels/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, intent }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '设置失败', 'error');
        setChannels(originalChannels);
        return;
      }
      showToast('意图已更新');
      clearSelection();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('设置失败', 'error');
      setChannels(originalChannels);
    }
  };

  // Batch add topics
  const handleBatchAddTopics = async (topics: string[]) => {
    if (selectedIds.size === 0 || topics.length === 0) return;
    const originalChannels = [...channels];
    const ids = Array.from(selectedIds);
    
    // Optimistic update: merging topics
    setChannels(prev => prev.map(ch => {
      if (ids.includes(ch.id)) {
        const newTopics = [...ch.topics];
        topics.forEach(t => {
          if (!newTopics.includes(t)) newTopics.push(t);
        });
        return { ...ch, topics: newTopics };
      }
      return ch;
    }));
    
    try {
      const res = await fetch('/api/channels/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, addTopics: topics }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || '添加失败', 'error');
        setChannels(originalChannels);
        return;
      }
      showToast('主题已添加');
      clearSelection();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('添加失败', 'error');
      setChannels(originalChannels);
    }
  };

  // Batch delete
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const confirmed = confirm(
      `确定要取消订阅选中的 ${selectedIds.size} 个频道吗？此操作不可撤销。`,
    );
    if (!confirmed) return;

    let deleted = 0;
    let failed = 0;
    for (const id of selectedIds) {
      try {
        const res = await fetch(`/api/channels/${id}`, { method: 'DELETE' });
        if (res.ok) deleted++;
        else failed++;
      } catch {
        failed++;
      }
    }

    if (failed === 0) {
      showToast(`已取消订阅 ${deleted} 个频道`);
    } else {
      showToast(`删除 ${deleted} 个，失败 ${failed} 个`, 'error');
    }
    clearSelection();
    await loadChannels();
    window.dispatchEvent(new Event('sidebar:refresh'));
  };

  // Add channel
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        setAddError(d.error || '添加失败');
        return;
      }
      setUrl('');
      showToast('频道添加成功！');
      setShowAddForm(false);
      await loadChannels();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      setAddError('网络错误，请重试');
    } finally {
      setAdding(false);
    }
  };

  // Markdown import
  const handleImportMarkdown = async () => {
    if (!importMarkdown.trim()) return;
    setImporting(true);
    try {
      const res = await fetch('/api/channels/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: importMarkdown }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || '导入失败', 'error');
        return;
      }
      showToast(`导入完成：新增 ${data.created}，更新 ${data.updated}`);
      setImportMarkdown('');
      setShowImportPanel(false);
      await loadChannels();
      window.dispatchEvent(new Event('sidebar:refresh'));
    } catch {
      showToast('导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleExportMarkdown = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/channels/markdown');
      if (!res.ok) {
        throw new Error(`导出失败 (${res.status})`);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = res.headers.get('Content-Disposition');
      const filenameMatch = disposition?.match(/filename="([^"]+)"/);
      link.href = downloadUrl;
      link.download = filenameMatch?.[1] || 'needle-subscriptions.md';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
      showToast('订阅已导出');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '导出失败，请稍后重试';
      showToast(message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const selectedCount = selectedIds.size;

  return (
    <>
      <style>
        {`
          .sticky-controls {
            position: sticky;
            top: -16px;
            z-index: 100;
            background: var(--bg-primary);
            padding: 16px 0;
            margin: 0 -16px 24px -16px;
            padding-left: 16px;
            padding-right: 16px;
            border-bottom: 1px solid var(--border);
            backdrop-filter: blur(20px) saturate(180%);
            mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
          }
          
          .dark .sticky-controls {
            background: rgba(15, 15, 20, 0.8);
          }
          
          .group-header-line {
            height: 1px;
            flex: 1;
            background: linear-gradient(to right, var(--accent-purple), transparent);
            opacity: 0.2;
          }

          .stat-pill {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--bg-hover);
            padding: 4px 12px;
            border-radius: 99px;
            font-size: 13px;
            color: var(--text-secondary);
            border: 1px solid var(--border);
          }

          .action-group {
            display: flex;
            align-items: center;
            background: var(--bg-card);
            border-radius: 12px;
            padding: 2px;
            border: 1px solid var(--border);
          }

          .layout-split {
            display: grid;
            grid-template-columns: 400px 1fr;
            gap: 24px;
            align-items: start;
            animation: fadeIn 0.3s ease-out;
          }

          .layout-split.focus-mode {
            grid-template-columns: 1fr 1fr;
            gap: 0;
            margin: 0 -16px;
            border-top: 1px solid var(--border);
            height: calc(100vh - 120px);
          }

          .layout-sidebar {
            position: sticky;
            top: 56px;
            max-height: calc(100vh - 100px);
            overflow-y: auto;
            padding-bottom: 20px;
          }

          .focus-mode .layout-sidebar {
            position: relative;
            height: 100%;
            overflow-y: auto;
            padding: 24px;
            background: var(--bg-primary);
            border-right: 1px solid var(--border);
            max-height: none;
            top: 0;
          }

          .layout-content {
            min-width: 0;
            flex: 1;
            padding: 0 16px;
          }

          .focus-mode .layout-content {
            height: 100%;
            overflow-y: auto;
            background: rgba(139, 92, 246, 0.02);
            padding: 24px;
          }

          /* Compact Card & Header Styles */
          .focus-mode .group-header {
            margin-top: 16px !important;
            margin-bottom: 12px !important;
            padding: 8px 12px !important;
            background: rgba(139, 92, 246, 0.05) !important;
            border: 1px solid rgba(139, 92, 246, 0.1) !important;
          }

          .focus-mode .group-header h3 {
            font-size: 13px !important;
          }

          .focus-mode .group-header button {
            display: none !important; /* Hide select all in reference mode */
          }

          .channel-card.compact {
            padding: 8px !important;
            gap: 6px !important;
            border-radius: var(--radius-md) !important;
          }

          .channel-card.compact .avatar {
            width: 32px !important;
            height: 32px !important;
          }

          .channel-card.compact .name {
            font-size: 12px !important;
            font-weight: 500 !important;
          }
          .channel-card.compact .meta {
            display: none !important;
          }
          .channel-card.compact .checkbox {
            top: 6px !important;
            left: 6px !important;
            width: 14px !important;
            height: 14px !important;
            font-size: 9px !important;
          }
          .channel-card.compact .platform-badge {
            width: 14px !important;
            height: 14px !important;
            padding: 1px !important;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }

          @media (max-width: 1200px) {
            .layout-split {
              grid-template-columns: 1fr;
            }
            .layout-sidebar {
              position: static;
              max-height: none;
            }
          }
        `}
      </style>
      
      {/* Header */}
      <div className="section-header" style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1 className="section-title" style={{ margin: 0 }}>频道管理</h1>
          <div className="stat-pill">
            <span style={{ opacity: 0.7 }}>已订阅</span>
            <span style={{ fontSize: 15, fontWeight: 800 }}>{channels.length}</span>
            <span style={{ opacity: 0.7 }}>个频道</span>
          </div>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Data Management Group */}
          <div className="action-group">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowImportPanel((v) => !v);
                if (showAddForm) setShowAddForm(false);
              }}
              style={{ border: 'none', background: showImportPanel ? 'var(--bg-hover)' : 'transparent', borderRadius: 8 }}
              title="Markdown 导入"
            >
              📝 <span style={{ marginLeft: 2 }}>{showImportPanel ? '收起' : '导入 MD'}</span>
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowUnifiedImport((v) => !v);
                if (showAddForm) setShowAddForm(false);
                if (showImportPanel) setShowImportPanel(false);
              }}
              style={{ border: 'none', background: showUnifiedImport ? 'var(--bg-hover)' : 'transparent', borderRadius: 8 }}
            >
              📥 <span style={{ marginLeft: 2 }}>{showUnifiedImport ? '收起' : '导入订阅'}</span>
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleExportMarkdown}
              disabled={exporting}
              style={{ border: 'none', background: 'transparent', borderRadius: 8 }}
            >
              {exporting ? '⏳' : '📤'} <span style={{ marginLeft: 2 }}>{exporting ? '导出中…' : '导出 MD'}</span>
            </button>
          </div>

          {/* Primary Action */}
          <button
            className={`btn ${showAddForm ? 'btn-ghost' : 'btn-primary'} btn-sm`}
            onClick={() => {
              setShowAddForm((v) => !v);
              if (showImportPanel) setShowImportPanel(false);
            }}
            style={{ 
              paddingLeft: 16, 
              paddingRight: 16, 
              height: 36, 
              borderRadius: 12,
              boxShadow: showAddForm ? 'none' : '0 4px 12px rgba(139, 92, 246, 0.3)'
            }}
          >
            {showAddForm ? '✕ 关闭添加' : '➕ 添加新频道'}
          </button>
        </div>
      </div>

      <div className={(showAddForm || showImportPanel || showUnifiedImport) ? `layout-split ${showUnifiedImport ? 'focus-mode' : ''}` : "layout-full"}>
        {/* Working Area (Main form or Sidebar tool) */}
        {(showAddForm || showImportPanel || showUnifiedImport) && (
          <div className="layout-sidebar">
            {/* Unified Login Import (As Main Body in Focus mode) */}
            {showUnifiedImport && (
              <div style={{ minHeight: '600px' }}>
                <UnifiedImportModal
                  variant="inline"
                  hasCookiesBrowser={hasCookiesBrowser}
                  onClose={() => setShowUnifiedImport(false)}
                  onImported={() => {
                    void loadChannels();
                    showToast('订阅导入完成');
                  }}
                />
              </div>
            )}

            {/* Add Form */}
            {showAddForm && (
              <div className="add-form" style={{ marginTop: 0, border: '2px solid var(--accent-purple)', boxShadow: 'var(--shadow-lg)' }}>
                <div className="add-form-title">➕ 添加订阅</div>
                <form onSubmit={handleAdd}>
                  <div className="input-row">
                    <input
                      type="text"
                      className="text-input"
                      placeholder="粘贴 URL 订阅…"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      disabled={adding}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={adding || !url.trim()}
                    >
                      {adding ? '...' : '订阅'}
                    </button>
                  </div>
                  {addError && <div className="error-msg">⚠ {addError}</div>}
                  <div className="form-hint" style={{ fontSize: 11 }}>
                    支持 YouTube/B站 UP主主页
                  </div>
                </form>
              </div>
            )}

            {/* Markdown Import Panel */}
            {showImportPanel && (
              <div className="add-form" style={{ marginTop: 0, border: '2px solid var(--accent-purple)', boxShadow: 'var(--shadow-lg)' }}>
                <div className="add-form-title">Markdown 批量导入</div>
                <div className="form-hint" style={{ marginBottom: 12 }}>
                  粘贴无序列表链接，自动解析分类。
                </div>
                <textarea
                  className="text-input"
                  value={importMarkdown}
                  onChange={(e) => setImportMarkdown(e.target.value)}
                  placeholder={'粘贴 Markdown，例如：\n- 分类\n  - [名字](链接)'}
                  rows={15}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    paddingTop: 12,
                    lineHeight: 1.5,
                    background: 'var(--bg-secondary)',
                    minHeight: 300
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    marginTop: 12,
                  }}
                >
                  <button
                    className="btn btn-primary"
                    onClick={handleImportMarkdown}
                    disabled={importing || !importMarkdown.trim()}
                    style={{ width: '100%', height: 40 }}
                  >
                    {importing ? '⏳ 导入中…' : '开始导入'}
                  </button>
                  <div className="form-hint">
                    分类层级会映射到意图和主题标签。
                  </div>
                </div>
              </div>
            )}
            
            <div style={{ marginTop: 24, padding: '16px', borderRadius: 'var(--radius-lg)', background: 'rgba(139, 92, 246, 0.03)', border: '1px dashed rgba(139, 92, 246, 0.2)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-purple)', marginBottom: 4 }}>💡 对比小贴士</div>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                右侧列表已同步刷新。你可以通过搜索框快速确认某个账号是否已在订阅列表中，从而避免重复添加。
              </p>
            </div>
          </div>
        )}

        {/* Reference List Section */}
        <div className="layout-content">

          {/* Controls */}
          <div className="sticky-controls" style={showUnifiedImport ? { position: 'static', margin: '0 0 16px 0', padding: 0, border: 'none', background: 'transparent' } : {}}>
            {/* Search */}
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                className="text-input"
                placeholder="🔍 搜索频道名称…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: '100%', maxWidth: showUnifiedImport ? 'none' : 400, background: 'var(--bg-card)' }}
              />
            </div>

            <div style={{ display: 'flex', gap: showUnifiedImport ? 8 : 16, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Platform Filter */}
              <div style={{ display: 'flex', gap: 4 }}>
                {(['all', 'youtube', 'bilibili'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPlatformFilter(p)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 99,
                      border: '1px solid',
                      borderColor:
                        platformFilter === p ? 'var(--accent-purple)' : 'var(--border)',
                      background:
                        platformFilter === p ? 'var(--accent-purple)' : 'var(--bg-card)',
                      color: platformFilter === p ? 'white' : 'var(--text-secondary)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {p === 'all' ? '全部' : p === 'youtube' ? 'YouTube' : 'B站'}
                  </button>
                ))}
              </div>

              {!showUnifiedImport && <div style={{ width: 1, height: 16, background: 'var(--border)' }} />}

              {/* Intent Filter */}
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => setIntentFilter('all')}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.style.transform = 'scale(1.1)';
                    e.currentTarget.style.boxShadow = '0 0 10px var(--accent-purple)';
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.style.transform = 'scale(1)';
                    e.currentTarget.style.boxShadow = 'none';
                    void handleDropToIntent(null, '未分类');
                  }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 99,
                    border: '1px solid',
                    borderColor:
                      intentFilter === 'all' ? 'var(--accent-purple)' : 'var(--border)',
                    background:
                      intentFilter === 'all' ? 'var(--accent-purple)' : 'var(--bg-card)',
                    color: intentFilter === 'all' ? 'white' : 'var(--text-secondary)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  全部
                </button>
                {intents
                  .slice()
                  .sort((a, b) => {
                    if (a.name === '未分类') return 1;
                    if (b.name === '未分类') return -1;
                    return a.sort_order - b.sort_order;
                  })
                  .map((intent) => (
                    <button
                      key={intent.id}
                      onClick={() => setIntentFilter(intent.name)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.currentTarget.style.transform = 'scale(1.1)';
                        e.currentTarget.style.boxShadow = '0 0 10px var(--accent-purple)';
                      }}
                      onDragLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.boxShadow = 'none';
                        const dragIdStr = localStorage.getItem('drag-channel-id');
                        const dragIdsStr = localStorage.getItem('drag-channel-ids');
                        const dragInfoStr = localStorage.getItem('drag-account-info');
                        const dragInfosStr = localStorage.getItem('drag-accounts-info');

                        if (dragIdsStr || dragInfosStr) {
                          void handleDropToIntent(null, intent.name);
                        } else if (dragIdStr) {
                          void handleDropToIntent(parseInt(dragIdStr, 10), intent.name);
                          localStorage.removeItem('drag-channel-id');
                        } else if (dragInfoStr) {
                          void handleDropToIntent(null, intent.name);
                        }
                      }}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 99,
                        border: '1px solid',
                        borderColor:
                          intentFilter === intent.name
                            ? 'var(--accent-purple)'
                            : 'var(--border)',
                        background:
                          intentFilter === intent.name
                            ? 'var(--accent-purple)'
                            : 'var(--bg-card)',
                        color:
                          intentFilter === intent.name
                            ? 'white'
                            : 'var(--text-secondary)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      {intent.name}
                    </button>
                  ))}
              </div>

              <div style={{ width: 1, height: 16, background: 'var(--border)', marginLeft: 'auto' }} />

              {/* Sort toggles */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>排序</span>
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => handleSortToggle(opt.key)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid',
                      borderColor:
                        sortKey === opt.key ? 'var(--accent-purple)' : 'var(--border)',
                      background:
                        sortKey === opt.key
                          ? 'rgba(139, 92, 246, 0.1)'
                          : 'var(--bg-card)',
                      color:
                        sortKey === opt.key
                          ? 'var(--accent-purple)'
                          : 'var(--text-muted)',
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.label}
                    {sortKey === opt.key && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* List Content */}
          {loading ? (
            <div className="loading-spinner">
              <div className="spinner" />
              加载中…
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🔍</div>
              <div className="empty-state-title">没有匹配的频道</div>
              <div className="empty-state-desc">
                {searchQuery || platformFilter !== 'all' || intentFilter !== 'all'
                  ? '尝试调整筛选条件'
                  : '在上方输入频道链接开始订阅'}
              </div>
            </div>
          ) : (
            <>
              {groupedChannels.map((group) => {
                const groupIds = group.channels.map((ch) => ch.id);
                const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.has(id));
                return (
                  <div key={group.intent.id}>
                    <GroupHeader
                      intentName={group.intent.name}
                      channelCount={group.channels.length}
                      allSelected={allSelected}
                      onToggleAll={() => toggleGroup(group.intent.name, groupIds)}
                      onDrop={(intent) => {
                        const dragIdStr = localStorage.getItem('drag-channel-id');
                        const dragIdsStr = localStorage.getItem('drag-channel-ids');
                        const dragInfoStr = localStorage.getItem('drag-account-info');
                        const dragInfosStr = localStorage.getItem('drag-accounts-info');

                        if (dragIdsStr || dragInfosStr) {
                          void handleDropToIntent(null, intent);
                        } else if (dragIdStr) {
                          void handleDropToIntent(parseInt(dragIdStr, 10), intent);
                          localStorage.removeItem('drag-channel-id');
                        } else if (dragInfoStr) {
                          void handleDropToIntent(null, intent);
                        }
                      }}
                    />
                    <div 
                      style={{ 
                        display: 'grid', 
                        gridTemplateColumns: `repeat(auto-fill, minmax(${showUnifiedImport ? '120px' : '180px'}, 1fr))`, 
                        gap: showUnifiedImport ? 10 : 16,
                        minHeight: 120,
                        padding: '12px',
                        borderRadius: 'var(--radius-lg)',
                        background: 'rgba(0,0,0,0.01)',
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const dragIdStr = localStorage.getItem('drag-channel-id');
                        const dragIdsStr = localStorage.getItem('drag-channel-ids');
                        const dragInfoStr = localStorage.getItem('drag-account-info');
                        const dragInfosStr = localStorage.getItem('drag-accounts-info');

                        if (dragIdsStr || dragInfosStr) {
                          void handleDropToIntent(null, group.intent.name);
                        } else if (dragIdStr) {
                          void handleDropToIntent(parseInt(dragIdStr, 10), group.intent.name);
                          localStorage.removeItem('drag-channel-id');
                        } else if (dragInfoStr) {
                          void handleDropToIntent(null, group.intent.name);
                        }
                      }}
                    >
                      {group.channels.map((ch) => (
                        <ChannelCard
                          key={ch.id}
                          channel={ch}
                          intents={intents}
                          allTopics={allTopics}
                          selected={selectedIds.has(ch.id)}
                          onToggle={toggleSelected}
                          onIntentChange={handleIntentChange}
                          onTopicsChange={handleTopicsChange}
                          onDelete={handleDelete}
                          onDragStart={(_, id) => {
                            if (selectedIds.has(id)) {
                              localStorage.setItem('drag-channel-ids', JSON.stringify(Array.from(selectedIds)));
                            } else {
                              localStorage.setItem('drag-channel-id', id.toString());
                            }
                          }}
                          onDragEnd={() => {
                            localStorage.removeItem('drag-channel-id');
                            localStorage.removeItem('drag-channel-ids');
                          }}
                          isCompact={showUnifiedImport}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {selectedCount > 0 && (
                <div style={{ marginTop: 16 }}>
                  <BatchOpsBar
                    selectedCount={selectedCount}
                    intents={intents}
                    allTopics={allTopics}
                    onSetIntent={handleBatchSetIntent}
                    onAddTopics={handleBatchAddTopics}
                    onDelete={handleBatchDelete}
                    onClear={clearSelection}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
