export { default as InputNode } from './InputNode'
export { default as OutputNode } from './OutputNode'
export { default as EmployeeNode } from './EmployeeNode'
export { default as BranchNode } from './BranchNode'
export { default as MergeNode } from './MergeNode'
export { default as ExtractNode } from './ExtractNode'

import InputNode from './InputNode'
import OutputNode from './OutputNode'
import EmployeeNode from './EmployeeNode'
import BranchNode from './BranchNode'
import MergeNode from './MergeNode'
import ExtractNode from './ExtractNode'

export const nodeTypes = {
  input: InputNode,
  output: OutputNode,
  employee: EmployeeNode,
  branch: BranchNode,
  merge: MergeNode,
  extract: ExtractNode,
}
