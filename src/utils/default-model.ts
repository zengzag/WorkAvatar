export type SceneKey = 'creation' | 'workbench' | 'knowledge' | 'quick' | 'embedding' | 'memory'

export interface SceneDefaultModel {
  provider_id: string
  model_id: string
}

const STORAGE_KEYS: Record<SceneKey, string> = {
  creation: 'default_model_creation',
  workbench: 'default_model_workbench',
  knowledge: 'default_model_knowledge',
  quick: 'default_model_quick',
  embedding: 'default_model_embedding',
  memory: 'default_model_memory',
}

const localStorageKeys: Record<SceneKey, string> = {
  creation: 'defaultModel:creation',
  workbench: 'defaultModel:workbench',
  knowledge: 'defaultModel:knowledge',
  quick: 'defaultModel:quick',
  embedding: 'defaultModel:embedding',
  memory: 'defaultModel:memory',
}

export async function getSceneDefaultModel(scene: SceneKey): Promise<SceneDefaultModel | null> {
  try {
    const value = await window.electronAPI.settings.get({ key: STORAGE_KEYS[scene] })
    if (value) {
      return JSON.parse(value) as SceneDefaultModel
    }
  } catch {}
  return null
}

export async function setSceneDefaultModel(scene: SceneKey, config: SceneDefaultModel): Promise<void> {
  await window.electronAPI.settings.set({
    key: STORAGE_KEYS[scene],
    value: JSON.stringify(config),
  })
  localStorage.setItem(localStorageKeys[scene], JSON.stringify(config))
}

export async function getAllSceneDefaultModels(): Promise<Record<SceneKey, SceneDefaultModel | null>> {
  const [creation, workbench, knowledge, quick, embedding, memory] = await Promise.all([
    getSceneDefaultModel('creation'),
    getSceneDefaultModel('workbench'),
    getSceneDefaultModel('knowledge'),
    getSceneDefaultModel('quick'),
    getSceneDefaultModel('embedding'),
    getSceneDefaultModel('memory'),
  ])
  return { creation, workbench, knowledge, quick, embedding, memory }
}

export function getCachedSceneDefaultModel(scene: SceneKey): SceneDefaultModel | null {
  try {
    const cached = localStorage.getItem(localStorageKeys[scene])
    if (cached) {
      return JSON.parse(cached) as SceneDefaultModel
    }
  } catch {}
  return null
}
