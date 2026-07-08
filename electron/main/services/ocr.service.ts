import fs from 'fs'
import path from 'path'
import { createWorker } from 'tesseract.js'
import { createLogger } from './logger'

const logger = createLogger('OCR')

interface OCROptions {
  language?: string
  engine?: 'tesseract' | 'rapidocr'
}

interface OCRResult {
  text: string
  confidence: number
  engine: string
  blocks?: Array<{
    text: string
    confidence: number
    bbox: {
      x0: number
      y0: number
      x1: number
      y1: number
    }
  }>
}

class OCRService {
  private static instance: OCRService
  private tesseractWorker: Tesseract.Worker | null = null
  private rapidOCRAvailable: boolean = false
  private rapidOCRPath: string | null = null

  private constructor() {}

  static getInstance(): OCRService {
    if (!OCRService.instance) {
      OCRService.instance = new OCRService()
    }
    return OCRService.instance
  }

  async initialize(): Promise<void> {
    await this.checkRapidOCR()
  }

  private async checkRapidOCR(): Promise<void> {
    try {
      const { app } = require('electron')
      const rapidOCRDir = path.join(app.getAppPath(), 'resources', 'rapidocr')
      const executableName = process.platform === 'win32' ? 'RapidOCR.exe' : 'RapidOCR'
      const rapidOCRExe = path.join(rapidOCRDir, executableName)

      if (fs.existsSync(rapidOCRExe)) {
        this.rapidOCRPath = rapidOCRExe
        this.rapidOCRAvailable = true
        logger.info('RapidOCR found at:', rapidOCRExe)
      } else {
        logger.info('RapidOCR not found, will use Tesseract.js')
      }
    } catch {
      logger.info('RapidOCR check failed, will use Tesseract.js')
    }
  }

  private async runRapidOCR(imagePath: string, language: string = 'ch_sim+en'): Promise<OCRResult> {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process')
      const proc = spawn(this.rapidOCRPath!, [
        '--image', imagePath,
        '--output', 'json',
        '--lang', language,
      ], { timeout: 60000 })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`RapidOCR exited with code ${code}: ${stderr}`))
          return
        }
        try {
          const result = JSON.parse(stdout)
          const blocks = result.blocks?.map((b: any) => ({
            text: b.text || '',
            confidence: b.confidence || 0.85,
            bbox: b.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
          })) || []

          resolve({
            text: result.text || blocks.map((b: any) => b.text).join('\n') || '',
            confidence: result.confidence || 0.85,
            engine: 'rapidocr',
            blocks,
          })
        } catch {
          reject(new Error('Failed to parse RapidOCR output'))
        }
      })

      proc.on('error', (err: Error) => {
        reject(err)
      })
    })
  }

  private async runTesseract(imagePath: string, language: string = 'chi_sim+eng'): Promise<OCRResult> {
    if (!this.tesseractWorker) {
      this.tesseractWorker = await createWorker(language)
    }

    const { data } = await this.tesseractWorker.recognize(imagePath)

    const blocks = data.blocks?.map((block: any) => ({
      text: block.text || '',
      confidence: block.confidence || 0,
      bbox: block.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
    })) || []

    return {
      text: data.text || '',
      confidence: data.confidence ? data.confidence / 100 : 0.8,
      engine: 'tesseract.js',
      blocks,
    }
  }

  async recognize(imagePath: string, options?: OCROptions): Promise<OCRResult> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`)
    }

    const engine = options?.engine || (this.rapidOCRAvailable ? 'rapidocr' : 'tesseract')
    const language = options?.language || 'chi_sim+eng'

    if (engine === 'rapidocr' && this.rapidOCRAvailable && this.rapidOCRPath) {
      try {
        return await this.runRapidOCR(imagePath, language)
      } catch (err) {
        logger.warn('RapidOCR failed, falling back to Tesseract.js:', err)
        return await this.runTesseract(imagePath, language)
      }
    }

    return await this.runTesseract(imagePath, language)
  }

  async recognizeBuffer(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const tempPath = path.join(require('os').tmpdir(), `ocr_${Date.now()}.png`)
    try {
      await fs.promises.writeFile(tempPath, imageBuffer)
      const result = await this.recognize(tempPath, options)
      return result
    } finally {
      try {
        await fs.promises.unlink(tempPath)
      } catch (error) {
        logger.debug('Failed to delete OCR temp file', tempPath, error)
      }
    }
  }

  async terminate(): Promise<void> {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate()
      this.tesseractWorker = null
    }
  }

  isRapidOCRAvailable(): boolean {
    return this.rapidOCRAvailable
  }
}

export default OCRService
