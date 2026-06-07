interface Props {
  message: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

export default function ConfirmModal({ message, onConfirm, onCancel, danger = false }: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box confirm-modal" onClick={e => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
