'use client';

import React from 'react';
import type { VideoWithMeta } from '@/types';

interface ShareCardProps {
  video: VideoWithMeta;
  quotes: Array<{ timestamp: string; text: string }>;
  commentary: string;
  summary: string;
  cardRef: React.RefObject<HTMLDivElement>;
}

export const ShareCard: React.FC<ShareCardProps> = ({
  video,
  quotes,
  commentary,
  summary,
  cardRef,
}) => {
  const cardWidth = 540;
  const accentPurple = '#8b5cf6';
  const bgColor = '#1a1a2e';
  const surfaceColor = 'rgba(255, 255, 255, 0.05)';
  const textColor = '#e0e0e0';
  const textMuted = '#94a3b8';

  return (
    <div
      ref={cardRef}
      style={{
        width: `${cardWidth}px`,
        background: bgColor,
        borderRadius: '24px',
        overflow: 'hidden',
        color: textColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 1. Thumbnail Header */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9' }}>
        {video.thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
            src={video.thumbnail_url}
            alt="thumbnail"
            crossOrigin="anonymous"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
        )}
        <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '60%',
            background: 'linear-gradient(to top, rgba(26, 26, 46, 1), transparent)',
        }} />
      </div>

      {/* 2. Video Info */}
      <div style={{ padding: '0 32px 24px 32px', marginTop: '-40px', position: 'relative', zIndex: 2 }}>
        <h1 style={{ 
            fontSize: '22px', 
            fontWeight: 800, 
            margin: '0 0 8px 0', 
            lineHeight: 1.3,
            color: '#fff',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
        }}>
          {video.title}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '14px', color: textMuted }}>
          <span style={{ color: video.platform === 'youtube' ? '#ff0000' : '#00aeec', fontWeight: 700 }}>
              {video.platform === 'youtube' ? 'YouTube' : 'Bilibili'}
          </span>
          <span>•</span>
          <span>{video.channel_name}</span>
        </div>
      </div>

      {/* 3. Summary / Hook */}
      {summary && (
        <div style={{ padding: '0 32px 24px 32px' }}>
            <div style={{
                background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.2), transparent)',
                padding: '12px 16px',
                borderRadius: '12px',
                borderLeft: `4px solid ${accentPurple}`,
                fontSize: '15px',
                fontWeight: 600,
                color: '#fff',
                fontStyle: 'italic'
            }}>
                {summary}
            </div>
        </div>
      )}

      {/* 4. Quotes Section */}
      {quotes.length > 0 && (
        <div style={{ padding: '0 32px 24px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {quotes.map((quote, idx) => (
                <div key={idx} style={{ 
                    background: surfaceColor, 
                    padding: '14px 18px', 
                    borderRadius: '16px',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                }}>
                    <span style={{ 
                        color: accentPurple, 
                        fontWeight: 800, 
                        marginRight: 8,
                        fontSize: '13px'
                    }}>
                        「{quote.timestamp}」
                    </span>
                    <span style={{ fontSize: '14px', lineHeight: 1.6 }}>{quote.text}</span>
                </div>
            ))}
        </div>
      )}

      {/* 5. Commentary Body */}
      <div style={{ padding: '0 32px 32px 32px' }}>
        <p style={{ 
            fontSize: '17px', 
            lineHeight: 1.7, 
            margin: 0, 
            color: '#fff',
            whiteSpace: 'pre-wrap'
        }}>
          {commentary}
        </p>
      </div>

      {/* 6. Footer / Watermark */}
      <div style={{ 
          padding: '20px 32px', 
          borderTop: '1px solid rgba(255, 255, 255, 0.05)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(0, 0, 0, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '18px', fontWeight: 900, color: '#fff', letterSpacing: '1px' }}>Needle</span>
            <span style={{ fontSize: '12px', color: textMuted }}>| 视频灵魂提取器</span>
        </div>
        <div style={{ fontSize: '11px', color: textMuted }}>
            {new Date().toLocaleDateString('zh-CN')} 生成
        </div>
      </div>
    </div>
  );
};
