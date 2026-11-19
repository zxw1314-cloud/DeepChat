import clsx from 'clsx'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import {
  IconAttachmentOutline22,
  IconCameraOutline22,
  IconGalleryOutline22,
  IconGlobeLanguageOutline14,
  IconImageGen14,
  IconPlusOutline18,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
  IconVoiceCall16,
} from '../base/icons.js'
import {
  matchesRefusalKeyword,
  setImageGen,
  setImageGenChannel,
  setSearch,
  setThinking,
  setThinkingEffort,
  useSettings,
  type ThinkingEffort,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { startVoiceCall } from '../../services/speech/voiceCall.js'
import { Tooltip } from '../base/Tooltip.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { ensureApiKey, openSettings } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { ImageSizePicker } from '../messages/ImageSizePicker.js'
import { useVoiceInput } from './useVoiceInput.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/**
 * 上下文窗口大小。模型名是从接口动态发现的，项目里没有窗口元数据，
 * 这里先按 1M 取值，后续应改为设置项或按模型名推断。
 */
const CONTEXT_WINDOW = 1_000_000

/** 达到该比例后环线转为警示色，提示即将触发截断 */
const CONTEXT_DANGER_RATIO = 0.9

/** 达到该比例后环线转为提醒色，提前预警 */
const CONTEXT_WARN_RATIO = 0.7

/** 环形进度：半径与周长（viewBox 32x32） */
const RING_RADIUS = 13.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 压缩成 12.2K / 128K / 1M 这类紧凑写法 */
const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`
  }
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}K`
  }
  return String(Math.round(value))
}

/** 环内空间有限，只保留整数位：38K / 1.2M */
const formatRingTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`
  }
  return String(Math.round(value))
}


/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  const chatProtocol = useSettings((state) => state.chatProtocol)
  const importingHistory = useChatStore((state) => state.importingHistory)
  /** 最近一轮回复实际送入模型的输入 token，即当前上下文占用量 */
  const contextUsage = useChatStore((state) => {
    const messages = sessionId ? state.sessionCache[sessionId]?.messages : undefined
    if (!messages) {
      return null
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === 'assistant' && message.usage) {
        return message.usage
      }
    }
    return null
  })
  const contextTokens = contextUsage
    ? contextUsage.input_tokens +
      contextUsage.cache_creation_input_tokens +
      contextUsage.cache_read_input_tokens
    : 0
  const contextRatio = Math.min(1, contextTokens / CONTEXT_WINDOW)
  const contextLabel = contextTokens
    ? t('contextUsageSummary', {
        percent: (contextRatio * 100).toFixed(contextRatio < 0.1 ? 1 : 0),
        used: formatTokenCount(contextTokens),
        window: formatTokenCount(CONTEXT_WINDOW),
      })
    : ''
  /** 环线颜色分级：常规 / 提醒（≥70%）/ 警示（≥90%） */
  const contextLevel =
    contextRatio >= CONTEXT_DANGER_RATIO
      ? styles.contextRingDanger
      : contextRatio >= CONTEXT_WARN_RATIO
        ? styles.contextRingWarn
        : null
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const imageGen = useSettings((state) => state.imageGen)
  const imageGenChannel = useSettings((state) => state.imageGenChannel)
  const imageGenReady = imageGenChannel.enabled && Boolean(imageGenChannel.model.trim())
  const hasImageAttachment = attachments.some((item) => item.isImage)
  const [plusOpen, setPlusOpen] = useState(false)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [holdCancelling, setHoldCancelling] = useState(false)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const thinkLongPressTimerRef = useRef<number | null>(null)
  const thinkLongPressTriggeredRef = useRef(false)
  const holdCancellingRef = useRef(false)
  const voiceHoldPendingRef = useRef(false)
  const voiceHoldActiveRef = useRef(false)
  const pendingVoiceAutoSendRef = useRef(false)
  const sendLatestRef = useRef<() => void>(() => {})
  const textareaWrapperRef = useRef<HTMLDivElement>(null)

  const effortOptions: ThinkingEffort[] =
    chatProtocol === 'deepseek' ? ['low', 'high', 'max'] : ['low', 'high', 'max', 'xhigh']
  const activeEffort: ThinkingEffort =
    chatProtocol === 'deepseek' && thinkingEffort === 'xhigh' ? 'max' : thinkingEffort

  const {
    anchorRef: thinkAnchorRef,
    floatingRef: effortMenuRef,
    position: effortMenuPosition,
  } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(effortMenuOpen, {
    side: 'top',
    align: 'start',
    offset: 8,
  })
  useDismiss(effortMenuOpen, [thinkAnchorRef, effortMenuRef], () => setEffortMenuOpen(false), {
    captureEscape: true,
  })

  useEffect(() => {
    if (!effortMenuOpen) {
      return
    }
    return registerAndroidBackHandler(45, () => {
      setEffortMenuOpen(false)
      return true
    })
  }, [effortMenuOpen])

  useEffect(() => {
    if (!plusOpen) {
      return
    }
    return registerAndroidBackHandler(40, () => {
      setPlusOpen(false)
      return true
    })
  }, [plusOpen])

  const openPicker = (ref: RefObject<HTMLInputElement>) => {
    const {
      imageGen: isImageGen,
      imageGenChannel: imgChannel,
      customHeaders,
    } = useSettings.getState()
    const hasCustomAuth =
      isImageGen &&
      imageGenReady &&
      Boolean(imgChannel.apiKey.trim() || imgChannel.customHeaders.trim() || customHeaders.trim())
    if (hasCustomAuth || ensureApiKey()) {
      ref.current?.click()
    }
  }

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t, thinking, activeEffort, imageGen])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory) {
      return
    }
    const {
      imageGen: isImageGen,
      imageGenChannel: imgChannel,
      customHeaders,
    } = useSettings.getState()
    const hasCustomAuth =
      isImageGen &&
      imageGenReady &&
      Boolean(imgChannel.apiKey.trim() || imgChannel.customHeaders.trim() || customHeaders.trim())
    if (!hasCustomAuth && !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处；开启语音自动发送时松开识别完直接发送 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    const nextText = current.slice(0, start) + transcript + current.slice(end)
    setText(nextText)
    if (useSettings.getState().voiceAutoSend && nextText.trim()) {
      pendingVoiceAutoSendRef.current = true
      return
    }
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  useEffect(() => {
    if (!pendingVoiceAutoSendRef.current || voice.status !== 'idle') {
      return
    }
    pendingVoiceAutoSendRef.current = false
    sendLatestRef.current()
  }, [voice.status, text, attachments])

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const hasDraftContent = text.trim() !== '' || attachments.length > 0
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady
  const showVoiceCall = !streaming && !hasDraftContent && voice.status === 'idle'
  const canVoiceCall = !importingHistory && voice.available

  const send = () => {
    const prepared = prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    if (useChatStore.getState().importingHistory || voice.status !== 'idle' || !prepared) {
      return
    }
    const {
      imageGen: isImageGen,
      imageGenChannel: imgChannel,
      customHeaders,
    } = useSettings.getState()
    const hasImageGenAuth =
      isImageGen &&
      imageGenReady &&
      Boolean(imgChannel.apiKey.trim() || imgChannel.customHeaders.trim() || customHeaders.trim())
    // 命中本地拒答关键词或已独立配置生图密钥时，无需强制校验主 API Key；文本与上传完成态由提交动作读取最新快照。
    if (
      (!matchesRefusalKeyword(prepared.text) && !hasImageGenAuth && !ensureApiKey()) ||
      !sendMessage(sessionId)
    ) {
      return
    }
    stopReadAloud()
    setPlusOpen(false)
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }
  sendLatestRef.current = send

  // 长按输入框语音输入：按住 340ms 开启录音 + 波形动画，上滑取消，松开识别
  const startVoiceHold = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      !voice.available ||
      voice.status !== 'idle' ||
      useChatStore.getState().importingHistory ||
      streaming
    ) {
      return
    }
    const wrapperEl = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let activated = false
    voiceHoldPendingRef.current = true
    holdCancellingRef.current = false
    setHoldCancelling(false)

    const preventNativeScroll = (touchEvent: TouchEvent) => {
      if (activated) {
        touchEvent.preventDefault()
      }
    }

    const clearListeners = () => {
      voiceHoldPendingRef.current = false
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('touchmove', preventNativeScroll)
      try {
        if (wrapperEl.hasPointerCapture?.(pointerId)) {
          wrapperEl.releasePointerCapture(pointerId)
        }
      } catch {
        // ignore release errors
      }
    }

    const timer = window.setTimeout(() => {
      if (useChatStore.getState().importingHistory || !ensureApiKey()) {
        clearListeners()
        return
      }
      activated = true
      voiceHoldActiveRef.current = true
      try {
        wrapperEl.setPointerCapture?.(pointerId)
      } catch {
        // ignore capture errors
      }
      textareaRef.current?.blur()
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(18)
      }
      void voice.start()
    }, 340)

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return
      }
      if (!activated) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 12) {
          window.clearTimeout(timer)
          clearListeners()
        }
        return
      }
      const nextCancel = moveEvent.clientY - startY < -52
      if (nextCancel !== holdCancellingRef.current) {
        holdCancellingRef.current = nextCancel
        setHoldCancelling(nextCancel)
      }
    }

    const finishHold = (shouldCancel: boolean) => {
      window.clearTimeout(timer)
      clearListeners()
      if (!activated) {
        return
      }
      voiceHoldActiveRef.current = false
      const cancelVoiceInput = shouldCancel || holdCancellingRef.current
      holdCancellingRef.current = false
      setHoldCancelling(false)
      if (cancelVoiceInput) {
        voice.cancel()
      } else {
        void voice.finish()
      }
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) {
        finishHold(false)
      }
    }

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) {
        finishHold(true)
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('touchmove', preventNativeScroll, { passive: false })
  }

  return (
    <div className={styles.inputHost}>
      {recording ? (
        <div
          className={clsx(
            styles.voiceExternalBanner,
            holdCancelling && styles.voiceExternalBannerCancel
          )}
        >
          <span className={styles.voiceHoldDot} />
          <span className={styles.voiceHoldTimer}>{voice.seconds}s</span>
          <span>{holdCancelling ? t('voiceHoldCancelHint') : t('voiceHoldRecording')}</span>
        </div>
      ) : voice.status === 'transcribing' ? (
        <button type="button" className={styles.voiceExternalBanner} onClick={() => voice.cancel()}>
          <span>{t('voiceHoldTranscribing')}</span>
        </button>
      ) : null}
      <div
        className={clsx(
          styles.wrapper,
          sessionId === null ? styles.home : styles.session,
          recording && (holdCancelling ? styles.voiceCancel : styles.voiceActive)
        )}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            textareaRef.current?.focus({ preventScroll: true })
          }
        }}
      >
        <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
        <div
          ref={textareaWrapperRef}
          className={clsx(styles.textareaWrapper, recording && styles.voiceHoldCapturing)}
          onPointerDown={startVoiceHold}
          onContextMenu={(event) => {
            if (voiceHoldPendingRef.current || voiceHoldActiveRef.current || recording) {
              event.preventDefault()
            }
          }}
        >
          <textarea
            ref={textareaRef}
            className={clsx(
              styles.textarea,
              (recording || voice.status === 'transcribing') && styles.textareaHidden
            )}
            placeholder={
              voice.available
                ? `${t('chatInputPlaceholderChat')} · ${t('voiceHoldHint')}`
                : t('chatInputPlaceholderChat')
            }
            rows={2}
            // 移动端不自动聚焦，避免一打开就弹出键盘
            autoFocus={!isMobile}
            disabled={importingHistory}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onMouseDown={(event) => {
              // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
              if (
                isMobile &&
                event.button === 0 &&
                document.activeElement !== event.currentTarget
              ) {
                event.preventDefault()
                event.currentTarget.focus({ preventScroll: true })
              }
            }}
            onKeyDown={(event) => {
              if (
                !isMobile &&
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                send()
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (files.length > 0) {
                event.preventDefault()
                acceptFiles(files)
              }
            }}
          />
          {recording ? (
            <div className={styles.voiceHoldStage}>
              <Spectrum getAnalyser={voice.getAnalyser} />
            </div>
          ) : null}
          <div className={styles.mirror} aria-hidden>
            {`${text}\n`}
          </div>
        </div>
        <div className={styles.functionRow}>
          {/* 深度思考 / 智能搜索开关，长按深度思考可选思考强度 */}
          <div ref={togglesRef} className={styles.toggles}>
            <Tooltip content={t('deactivatedThinkTooltip')}>
              <button
                ref={thinkAnchorRef}
                type="button"
                className={clsx(styles.toggle, thinking && styles.selected)}
                aria-label={t('thinkingSwitch')}
                aria-pressed={thinking}
                onPointerDown={() => {
                  thinkLongPressTriggeredRef.current = false
                  if (thinkLongPressTimerRef.current !== null) {
                    window.clearTimeout(thinkLongPressTimerRef.current)
                  }
                  thinkLongPressTimerRef.current = window.setTimeout(() => {
                    thinkLongPressTriggeredRef.current = true
                    setEffortMenuOpen(true)
                  }, 420)
                }}
                onPointerUp={() => {
                  if (thinkLongPressTimerRef.current !== null) {
                    window.clearTimeout(thinkLongPressTimerRef.current)
                    thinkLongPressTimerRef.current = null
                  }
                }}
                onPointerLeave={() => {
                  if (thinkLongPressTimerRef.current !== null) {
                    window.clearTimeout(thinkLongPressTimerRef.current)
                    thinkLongPressTimerRef.current = null
                  }
                }}
                onPointerCancel={() => {
                  if (thinkLongPressTimerRef.current !== null) {
                    window.clearTimeout(thinkLongPressTimerRef.current)
                    thinkLongPressTimerRef.current = null
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  thinkLongPressTriggeredRef.current = true
                  setEffortMenuOpen(true)
                }}
                onClick={() => {
                  if (thinkLongPressTriggeredRef.current) {
                    thinkLongPressTriggeredRef.current = false
                    return
                  }
                  setThinking(!thinking)
                }}
              >
                <IconThinkOutline14 />
                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
                {thinking ? <span className={styles.effortBadge}>{activeEffort}</span> : null}
              </button>
            </Tooltip>
            {effortMenuOpen
              ? createPortal(
                  <div
                    ref={effortMenuRef}
                    className={styles.effortMenu}
                    style={effortMenuPosition ?? undefined}
                    role="menu"
                    aria-label={t('thinkingEffortTitle')}
                  >
                    <div className={styles.effortMenuTitle}>{t('thinkingEffortTitle')}</div>
                    <div className={styles.effortPills}>
                      {effortOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          role="menuitemradio"
                          aria-checked={activeEffort === option}
                          className={clsx(
                            styles.effortPill,
                            activeEffort === option && styles.effortPillActive
                          )}
                          onClick={() => {
                            setThinkingEffort(option)
                            setThinking(true)
                            setEffortMenuOpen(false)
                          }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>,
                  document.body
                )
              : null}
            <Tooltip content={t('deactivatedSearchTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, search && styles.selected)}
                aria-label={t('search')}
                aria-pressed={search}
                onClick={() => setSearch(!search)}
              >
                <IconGlobeLanguageOutline14 />
                <span className={styles.toggleLabel}>{t('search')}</span>
              </button>
            </Tooltip>
            <Tooltip content={t('imageGenTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, imageGen && imageGenReady && styles.selected)}
                aria-label={t('imageGenSwitch')}
                aria-pressed={imageGen && imageGenReady}
                onClick={() => {
                  if (!imageGenReady) {
                    showToast({ key: 'imageGenNotConfigured' })
                    openSettings('model')
                    return
                  }
                  setImageGen(!imageGen)
                }}
              >
                <IconImageGen14 />
                <span className={styles.toggleLabel}>{t('imageGenSwitch')}</span>
              </button>
            </Tooltip>
            {imageGen && imageGenReady ? (
              <ImageSizePicker
                compact
                value={imageGenChannel.size}
                hasReference={hasImageAttachment}
                onChange={(size) => setImageGenChannel({ ...imageGenChannel, size })}
              />
            ) : null}
          </div>
          <div className={styles.right}>
            {contextLabel ? (
              <Tooltip content={contextLabel}>
                <button
                  type="button"
                  className={clsx(styles.contextRing, contextLevel)}
                  aria-label={contextLabel}
                  onClick={() => {
                    // 移动端没有悬停，点按后把完整数值以轻提示展示
                    if (isMobile) {
                      showToast(contextLabel)
                    }
                  }}
                >
                  <svg viewBox="0 0 32 32" aria-hidden="true">
                    <circle cx="16" cy="16" r={RING_RADIUS} className={styles.contextRingTrack} />
                    <circle
                      cx="16"
                      cy="16"
                      r={RING_RADIUS}
                      className={styles.contextRingFill}
                      strokeDasharray={`${contextRatio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
                    />
                  </svg>
                  <span className={styles.contextRingLabel} aria-hidden="true">
                    {formatRingTokens(contextTokens)}
                  </span>
                </button>
              </Tooltip>
            ) : null}
            <Tooltip content={t('chatInputMoreActions')}>
              <button
                type="button"
                className={clsx(styles.plusButton, plusOpen && styles.plusOpen)}
                aria-label={t('chatInputMoreActions')}
                aria-expanded={plusOpen}
                disabled={importingHistory}
                onClick={() => setPlusOpen((value) => !value)}
              >
                <span className={styles.plusIcon}>
                  <IconPlusOutline18 />
                </span>
              </button>
            </Tooltip>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                acceptFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
                setPlusOpen(false)
              }}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                acceptFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
                setPlusOpen(false)
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={ACCEPT}
              onChange={(event) => {
                acceptFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
                setPlusOpen(false)
              }}
            />
            {streaming && sessionId ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('chatInputStopButtonTooltip')}
                onClick={() => {
                  stopReadAloud()
                  stopReply(sessionId)
                }}
              >
                <IconStopFill16 />
              </button>
            ) : showVoiceCall ? (
              <Tooltip
                content={voice.available ? t('voiceCallStart') : t('voiceInputRequiresHttps')}
              >
                <button
                  type="button"
                  className={clsx(styles.sendButton, !canVoiceCall && styles.disabled)}
                  aria-label={t('voiceCallStart')}
                  aria-disabled={!canVoiceCall}
                  onClick={() => {
                    if (canVoiceCall && ensureApiKey()) {
                      startVoiceCall(sessionId)
                    }
                  }}
                >
                  <IconVoiceCall16 />
                </button>
              </Tooltip>
            ) : (
              <button
                type="button"
                className={clsx(styles.sendButton, !canSend && styles.disabled)}
                aria-label={t('send')}
                aria-disabled={!canSend}
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            )}
          </div>
        </div>
      </div>
      <div
        className={clsx(styles.moreTray, plusOpen && styles.moreTrayOpen)}
        aria-hidden={!plusOpen}
      >
        <div className={styles.moreTrayInner}>
          <div className={styles.moreGrid}>
            <button
              type="button"
              className={styles.moreCard}
              tabIndex={plusOpen ? 0 : -1}
              disabled={importingHistory}
              onClick={() => openPicker(cameraInputRef)}
            >
              <IconCameraOutline22 />
              <span>{t('chatInputTakePhoto')}</span>
            </button>
            <button
              type="button"
              className={styles.moreCard}
              tabIndex={plusOpen ? 0 : -1}
              disabled={importingHistory}
              onClick={() => openPicker(galleryInputRef)}
            >
              <IconGalleryOutline22 />
              <span>{t('chatInputPhotoLibrary')}</span>
            </button>
            <button
              type="button"
              className={styles.moreCard}
              tabIndex={plusOpen ? 0 : -1}
              disabled={importingHistory}
              onClick={() => openPicker(fileInputRef)}
            >
              <IconAttachmentOutline22 />
              <span>{t('chatInputPickFiles')}</span>
            </button>
          </div>
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
