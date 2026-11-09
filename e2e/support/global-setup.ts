import { assertBuiltArtifacts } from './env'

export default async function globalSetup(): Promise<void> {
  assertBuiltArtifacts()
}
