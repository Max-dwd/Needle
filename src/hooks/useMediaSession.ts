'use client';

import { useEffect, useRef } from 'react';

export interface MediaSessionMetadata {
  title: string;
  artist: string;
  artwork: string;
  album?: string;
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onSeekBackward?: () => void;
  onSeekForward?: () => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
  onSeekTo?: (details: MediaSessionActionDetails) => void;
}

export function useMediaSession(
  metadata: MediaSessionMetadata | null,
  handlers: MediaSessionHandlers,
  playbackState: 'playing' | 'paused' | 'none',
  currentTime: number = 0,
  duration: number = 0,
) {
  // Use refs to keep handlers up-to-date without re-triggering the main effect.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Sync Position State
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('mediaSession' in navigator) ||
      !('setPositionState' in navigator.mediaSession) ||
      playbackState === 'none'
    ) {
      return;
    }

    try {
      // Small check to avoid invalid position state
      const validDuration = isFinite(duration) && duration > 0 ? duration : 0;
      const validPosition = isFinite(currentTime) && currentTime >= 0 && currentTime <= validDuration ? currentTime : 0;

      if (validDuration > 0) {
        navigator.mediaSession.setPositionState({
          duration: validDuration,
          playbackRate: 1.0,
          position: validPosition,
        });
      }
    } catch (e) {
      // console.error('Failed to set MediaSession position state', e);
    }
  }, [currentTime, duration, playbackState]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator) || !metadata) {
      return;
    }

    const session = navigator.mediaSession;

    // Set metadata
    try {
      if (typeof MediaMetadata === 'undefined') {
        return;
      }
      session.metadata = new MediaMetadata({
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album || 'Needle',
        artwork: [
          { src: metadata.artwork, sizes: '512x512', type: 'image/jpeg' },
          { src: metadata.artwork, sizes: '256x256', type: 'image/jpeg' },
        ],
      });
    } catch (e) {
      console.error('Failed to set MediaMetadata', e);
    }

    // Set Action Handlers
    const actions: (keyof MediaSessionHandlers)[] = [
      'onPlay', 'onPause', 'onSeekBackward', 'onSeekForward', 'onPreviousTrack', 'onNextTrack', 'onSeekTo'
    ];

    actions.forEach((action) => {
      const internalAction = action.replace('on', '').toLowerCase() as MediaSessionAction;
      try {
        if (handlersRef.current[action]) {
          session.setActionHandler(internalAction, (details) => {
            const currentHandler = handlersRef.current[action];
            if (currentHandler) {
              (currentHandler as any)(details);
            }
          });
        } else {
          session.setActionHandler(internalAction, null);
        }
      } catch (err) {
        // Some browsers may not support all actions.
      }
    });

    return () => {
      // Clean up metadata
      session.metadata = null;
      // Clean up action handlers
      const actionTypes: MediaSessionAction[] = [
        'play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto'
      ];
      actionTypes.forEach(type => {
        try {
          session.setActionHandler(type, null);
        } catch (e) {}
      });
    };
  }, [metadata]); // Only re-run when metadata changes

  useEffect(() => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      if (playbackState === 'playing') {
        navigator.mediaSession.playbackState = 'playing';
      } else if (playbackState === 'paused') {
        navigator.mediaSession.playbackState = 'paused';
      } else {
        navigator.mediaSession.playbackState = 'none';
      }
    } catch {
      // Some browsers expose mediaSession but throw when playbackState is set.
    }
  }, [playbackState]);
}
