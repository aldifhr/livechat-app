import { useCallback, useEffect, useState } from 'react'
import { host } from '../../lib/sidecar'
import { EMPTY_CONFIG, isReady, type LlmConfig } from '../../lib/llm'
import { message, type Status } from './shared'

/**
 * The saved model configuration, read from the host.
 *
 * It lives here rather than in the Model section because two sections depend on
 * it. The Model section edits the fields; the AI answers section needs to know
 * whether an endpoint and key are filled in before it will let its toggle be
 * turned on at all. Putting the state in Model and passing a boolean up would
 * mean the two could disagree for the frame between a keystroke and a re-render,
 * so the one answer is computed once here and handed to both.
 *
 * `enabled` rather than reading on mount, because the config comes off disk and
 * there is no reason to pay for that on every launch of the app — the dialog is
 * mounted from the start and opened far less often than it exists.
 */
export function useLlmConfig(enabled: boolean, setStatus: (status: Status) => void) {
  const [config, setConfig] = useState<LlmConfig>(EMPTY_CONFIG)
  // What is actually on disk, so the Model section can say whether it is testing
  // the fields in front of the user or the settings the features will really use.
  const [savedModel, setSavedModel] = useState<LlmConfig>(EMPTY_CONFIG)
  const [models, setModels] = useState<string[]>([])

  useEffect(() => {
    if (!enabled) return
    let active = true
    setStatus({ kind: 'busy', text: 'Loading saved settings…' })
    host
      .llmConfigGet()
      .then((saved) => {
        if (!active) return
        setConfig(saved)
        setSavedModel(saved)
        setModels(saved.model ? [saved.model] : [])
        setStatus({ kind: 'idle', text: '' })
      })
      .catch((error: unknown) => {
        if (!active) return
        setStatus({ kind: 'error', text: `Could not read the saved settings: ${message(error)}` })
      })
    return () => {
      active = false
    }
  }, [enabled, setStatus])

  const setConfigField = useCallback(<K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setConfig((previous) => ({ ...previous, [key]: value }))
  }, [])

  const setSaved = useCallback((saved: LlmConfig) => {
    // Kept in step with the fields, because "Test model" compares the two to say
    // whether it is testing what is on screen or what is on disk. A copy left
    // behind here would have it report unsaved changes forever.
    setConfig(saved)
    setSavedModel(saved)
  }, [])

  const forget = useCallback(() => {
    setConfig(EMPTY_CONFIG)
    setSavedModel(EMPTY_CONFIG)
    setModels([])
  }, [])

  const setModelList = useCallback((found: string[]) => {
    setModels(found)
  }, [])

  return {
    config,
    savedModel,
    models,
    setConfigField,
    setSaved,
    forget,
    setModelList,
    /** Whether an endpoint and key are both filled in. */
    ready: isReady(config),
  }
}