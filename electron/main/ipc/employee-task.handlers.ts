import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  EmployeeTaskCreateParams,
  EmployeeTaskUpdateParams,
  EmployeeScheduleCreateParams,
  EmployeeScheduleUpdateParams,
} from '../../shared/ipc-channels'
import type EmployeeTaskService from '../services/employee-task.service'
import type SchedulerService from '../services/scheduler.service'

export function registerEmployeeTaskHandlers(
  taskService: EmployeeTaskService,
  schedulerService: SchedulerService
) {
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_LIST, (_, employeeId: string) => {
    return taskService.getTasks(employeeId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_GET, (_, taskId: string) => {
    return taskService.getTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_CREATE, (_, params: EmployeeTaskCreateParams) => {
    return taskService.createTask(params.employee_id, params.name, params.description || '', params.prompt, params.timeout_ms, params.llm_provider_id, params.llm_model, params.enable_thinking, params.run_mode)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_UPDATE, (_, params: EmployeeTaskUpdateParams) => {
    const { id, ...data } = params
    return taskService.updateTask(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_DELETE, (_, taskId: string) => {
    return taskService.deleteTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_EXECUTE, async (_, taskId: string) => {
    try {
      const execution = await taskService.executeTask(taskId, 'manual')
      return { success: true, execution }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_TASK_ABORT_EXECUTION, (_, executionId: string) => {
    return taskService.abortExecution(executionId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_LIST, (_, employeeId: string) => {
    return taskService.getSchedules(employeeId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_GET, (_, scheduleId: string) => {
    return taskService.getSchedule(scheduleId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_CREATE, (_, params: EmployeeScheduleCreateParams) => {
    const schedule = taskService.createSchedule(params.employee_id, params.name, params.cron_expr, params.task_ids, params.run_mode)
    schedulerService.updateNextRunTimes()
    return schedule
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_UPDATE, (_, params: EmployeeScheduleUpdateParams) => {
    const { id, task_ids, ...data } = params
    const updateData: any = { ...data }
    if (task_ids !== undefined) {
      updateData.task_ids_json = JSON.stringify(task_ids)
    }
    const result = taskService.updateSchedule(id, updateData)
    schedulerService.updateNextRunTimes()
    return result
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_DELETE, (_, scheduleId: string) => {
    const result = taskService.deleteSchedule(scheduleId)
    schedulerService.updateNextRunTimes()
    return result
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_SCHEDULE_VALIDATE_CRON, (_, cronExpr: string) => {
    return schedulerService.validateCronExpression(cronExpr)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_LIST, (_, params: { employee_id: string; limit?: number; offset?: number }) => {
    return taskService.getExecutions(params.employee_id, params.limit, params.offset)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_LIST_FOR_TASK, (_, params: { task_id: string; limit?: number }) => {
    return taskService.getExecutionsForTask(params.task_id, params.limit)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_GET, (_, executionId: string) => {
    return taskService.getExecution(executionId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_ALL_RECENT, (_, limit?: number) => {
    return taskService.getAllRecentExecutions(limit)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_FAILED, (_, limit?: number) => {
    return taskService.getFailedExecutions(limit)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXECUTION_DELETE, (_, executionId: string) => {
    return taskService.deleteExecution(executionId)
  })
}
