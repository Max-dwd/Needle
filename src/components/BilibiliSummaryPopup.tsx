import React from 'react';
import { formatSecondsToDisplay } from '@/lib/format';

interface OutlinePart {
  timestamp: number;
  content: string;
}

interface OutlineSection {
  title: string;
  timestamp: number;
  part_outline: OutlinePart[];
}

export interface BilibiliSummaryData {
  model_result: {
    summary: string;
    outline: OutlineSection[];
  };
  error?: string;
  details?: string;
  authExpired?: boolean;
}

interface BilibiliSummaryPopupProps {
  data: BilibiliSummaryData;
  videoId: string;
  onTimestampClick?: (timestamp: number) => void;
}

export default function BilibiliSummaryPopup({
  data,
  videoId,
  onTimestampClick,
}: BilibiliSummaryPopupProps) {
  const summary = data.model_result?.summary;
  const outline = data.model_result?.outline;
  const authExpired = data.authExpired;
  const errorDetails = data.details;

  const handleTimestampClick = (
    e: React.MouseEvent<HTMLDivElement>,
    timestamp: number,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (onTimestampClick) {
      onTimestampClick(timestamp);
      return;
    }
    window.open(
      `https://www.bilibili.com/video/${videoId}/?t=${timestamp}`,
      '_blank',
    );
  };

  if (!summary && (!outline || outline.length === 0)) {
    return (
      <div id="biliscope-ai-summary-none">
        {authExpired ? (
          <>
            B站登录态失效，请前往{' '}
            <a
              href="/settings?tab=bilibili-summary"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              设置页
            </a>{' '}
            更新 SESSDATA
          </>
        ) : (
          errorDetails || '此视频不存在AI总结'
        )}
      </div>
    );
  }

  return (
    <div className="biliscope-ai-summary-popup">
      <div className="biliscope-ai-summary-popup-header">
        <div className="biliscope-ai-summary-popup-header-left">
          <svg
            width="30"
            height="30"
            viewBox="0 0 30 30"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="biliscope-ai-summary-popup-icon"
          >
            <g>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M7.53976 2.34771C8.17618 1.81736 9.12202 1.90335 9.65237 2.53976L12.1524 5.53976C12.6827 6.17618 12.5967 7.12202 11.9603 7.65237C11.3239 8.18272 10.3781 8.09673 9.84771 7.46031L7.34771 4.46031C6.81736 3.8239 6.90335 2.87805 7.53976 2.34771Z"
                fill="url(#paint0_linear_8728_3421)"
              />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M21.9602 2.34771C21.3238 1.81736 20.378 1.90335 19.8476 2.53976L17.3476 5.53976C16.8173 6.17618 16.9033 7.12202 17.5397 7.65237C18.1761 8.18272 19.1219 8.09673 19.6523 7.46031L22.1523 4.46031C22.6826 3.8239 22.5967 2.87805 21.9602 2.34771Z"
                fill="url(#paint1_linear_8728_3421)"
              />
              <g opacity="0.2">
                <path
                  d="M27 18.2533C27 25.0206 21.6274 27 15 27C8.37258 27 3 25.0206 3 18.2533C3 11.486 3.92308 6 15 6C26.5385 6 27 11.486 27 18.2533Z"
                  fill="#D9D9D9"
                />
              </g>
              <g>
                <path
                  d="M28 18.9489C28 26.656 22.1797 28 15 28C7.8203 28 2 26.656 2 18.9489C2 10 3 6 15 6C27.5 6 28 10 28 18.9489Z"
                  fill="url(#paint2_linear_8728_3421)"
                />
              </g>
              <path
                d="M4.78613 14.2091C4.78613 11.9263 6.44484 9.96205 8.71139 9.6903C13.2069 9.1513 16.7678 9.13141 21.3132 9.68091C23.5697 9.95371 25.2147 11.9138 25.2147 14.1868V19.192C25.2147 21.3328 23.7551 23.2258 21.6452 23.5884C16.903 24.4032 13.1705 24.2461 8.55936 23.5137C6.36235 23.1647 4.78613 21.2323 4.78613 19.0078V14.2091Z"
                fill="#191924"
              />
              <path
                d="M19.6426 15.3125L19.6426 18.0982"
                stroke="#2CFFFF"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <path
                d="M10.3574 14.8516L12.2146 16.7087L10.3574 18.5658"
                stroke="#2CFFFF"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
            <defs>
              <linearGradient
                id="paint0_linear_8728_3421"
                x1="6.80424"
                y1="2.84927"
                x2="9.01897"
                y2="8.29727"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#393946" />
                <stop offset="0.401159" stopColor="#23232E" />
                <stop offset="1" stopColor="#191924" />
              </linearGradient>
              <linearGradient
                id="paint1_linear_8728_3421"
                x1="22.6958"
                y1="2.84927"
                x2="20.481"
                y2="8.29727"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#393946" />
                <stop offset="0.401159" stopColor="#23232E" />
                <stop offset="1" stopColor="#191924" />
              </linearGradient>
              <linearGradient
                id="paint2_linear_8728_3421"
                x1="7.67091"
                y1="10.8068"
                x2="19.9309"
                y2="29.088"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#F4FCFF" />
                <stop offset="1" stopColor="#EAF5F9" />
              </linearGradient>
            </defs>
          </svg>
          <div className="biliscope-ai-summary-popup-tips">
            <span className="biliscope-ai-summary-popup-tips-text">
              已为您生成视频总结
            </span>
          </div>
        </div>
      </div>
      <div className="biliscope-ai-summary-popup-body">
        {summary && (
          <div className="biliscope-ai-summary-popup-body-abstracts">
            {summary}
          </div>
        )}
        {outline && outline.length > 0 && (
          <div className="biliscope-ai-summary-popup-body-outline">
            {outline.map((section, i) => (
              <div key={i} className="ai-summary-section">
                <div className="ai-summary-section-title">{section.title}</div>
                {section.part_outline.map((part, j) => (
                  <div
                    key={j}
                    className="bullet"
                    onClick={(e) => handleTimestampClick(e, part.timestamp)}
                  >
                    <span className="timestamp">
                      <span className="timestamp-inner">
                        {formatSecondsToDisplay(part.timestamp)}
                      </span>
                    </span>
                    <span className="content">{part.content}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
