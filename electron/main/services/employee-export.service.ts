import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'
import { EmployeeExportConfigService } from './employee-export-config.service'
import { EmployeeExportPackageService } from './employee-export-package.service'

class EmployeeExportService {
  private configService: EmployeeExportConfigService
  private packageService: EmployeeExportPackageService
  private static instance: EmployeeExportService

  private constructor() {
    const db = DatabaseService.getInstance()
    const kbDb = KBDatabaseService.getInstance()
    this.configService = new EmployeeExportConfigService(db, kbDb)
    this.packageService = new EmployeeExportPackageService(db, kbDb, this.configService)
  }

  static getInstance(): EmployeeExportService {
    if (!EmployeeExportService.instance) {
      EmployeeExportService.instance = new EmployeeExportService()
    }
    return EmployeeExportService.instance
  }

  exportConfig(
    employeeId: string,
    exportPath: string
  ): { success: boolean; error?: string } {
    return this.configService.exportConfig(employeeId, exportPath)
  }

  importConfig(
    importPath: string,
    conflictStrategy: 'skip' | 'overwrite' | 'merge' = 'merge'
  ): { success: boolean; error?: string; employeeId?: string; warnings?: string[] } {
    return this.configService.importConfig(importPath, conflictStrategy)
  }

  async exportPackage(
    employeeId: string,
    exportPath: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    return this.packageService.exportPackage(employeeId, exportPath, onProgress)
  }

  async importPackage(
    importPath: string,
    conflictStrategy: 'skip' | 'overwrite' | 'merge' = 'merge',
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string; employeeId?: string; warnings?: string[] }> {
    return this.packageService.importPackage(importPath, conflictStrategy, onProgress)
  }
}

export default EmployeeExportService
