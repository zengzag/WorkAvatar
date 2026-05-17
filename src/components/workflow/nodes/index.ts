export { default as InputNode } from './InputNode'
export { default as OutputNode } from './OutputNode'
export { default as EmployeeNode } from './EmployeeNode'

import InputNode from './InputNode'
import OutputNode from './OutputNode'
import EmployeeNode from './EmployeeNode'

export const nodeTypes = {
  input: InputNode,
  output: OutputNode,
  employee: EmployeeNode,
}
