import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
import express, { type Express } from 'express'

// Register after the API routes so an unknown API endpoint never receives the SPA.
export function mountFrontend(app: Express, root = resolve('dist')) {
  const index = resolve(root, 'index.html')
  accessSync(index)
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    next()
  })
  app.use('/assets', express.static(resolve(root, 'assets'), { immutable: true, maxAge: '1y' }), (_req, res) => res.sendStatus(404))
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-cache'); next() })
  app.use(express.static(root, { index: false, dotfiles: 'deny' }))
  app.get('/{*rest}', (_req, res) => res.sendFile(index))
}
