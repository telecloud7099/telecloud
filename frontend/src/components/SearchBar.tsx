import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { searchFiles } from '../api/client'
import { toast } from 'sonner'

interface Props {
  onResults: () => void
}

export default function SearchBar({ onResults }: Props) {
  const { files, setFiles, setLoading, isLoading, searchQuery, setSearchQuery } = useStore()
  const [localQ, setLocalQ] = useState(searchQuery)
  const [resultCount, setResultCount] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [])

  function handleChange(q: string) {
    setLocalQ(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) {
      setSearchQuery('')
      setFiles([])
      setResultCount(null)
      return
    }
    debounceRef.current = setTimeout(() => runSearch(q), 300)
  }

  async function runSearch(q: string) {
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    // Try local store first (instant)
    const lower = q.toLowerCase()
    const local = files.filter(f => f.name.toLowerCase().includes(lower))
    if (local.length > 0) {
      setFiles(local)
      setSearchQuery(q)
      setResultCount(local.length)
      onResults()
      return
    }

    // Cache cold — hit the API
    setLoading(true)
    setSearchQuery(q)
    try {
      const res = await searchFiles(q)
      const d = await res.json()
      if (d.status === 'success') {
        setFiles(d.files)
        setResultCount(d.files.length)
        onResults()
      } else {
        toast.error(d.message || 'Search failed')
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') toast.error('Search failed')
    } finally {
      setLoading(false)
    }
  }

  function clear() {
    setLocalQ('')
    setSearchQuery('')
    setFiles([])
    setResultCount(null)
    abortRef.current?.abort()
  }

  return (
    <div className="search-wrap">
      <form
        className="search-form"
        onSubmit={e => { e.preventDefault(); runSearch(localQ) }}
      >
        <div className="search-input-wrap">
          <span className="material-symbols-rounded search-icon">search</span>
          <input
            className="form-input search-input"
            placeholder="Search files by name…"
            value={localQ}
            onChange={e => handleChange(e.target.value)}
            autoFocus
          />
          {isLoading && (
            <span className="material-symbols-rounded search-spinner spin">progress_activity</span>
          )}
          {!isLoading && localQ && (
            <button type="button" className="search-clear icon-btn" onClick={clear}>
              <span className="material-symbols-rounded">close</span>
            </button>
          )}
        </div>
      </form>
      {!isLoading && localQ && resultCount !== null && (
        <div className="search-result-count">
          {resultCount === 0 ? 'No files found' : `${resultCount} file${resultCount !== 1 ? 's' : ''} found`}
        </div>
      )}
    </div>
  )
}
