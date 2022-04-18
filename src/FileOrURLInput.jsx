import React from 'react';
import PropTypes from 'prop-types';
import Modal from 'react-modal';

// TODO: Where to do this?
//   Modal.setAppElement(document.getElementsByClassName('App')[0]);
// Then remove this:
//   ariaHideApp={false}

export default function FileOrURLInput (props) {
  const {
    accept,
    onChange,
    disabled,
    modalContentClassName,
    modalOverlayClassName
  } = props;

  const [text, setText] = React.useState("Click to choose...");
  const [lastUrl, setLastURL] = React.useState("");
  const [modalIsOpen, setModalIsOpen] = React.useState(false);

  const onMainClick = () => {
    setModalIsOpen(true);
  }

  const onInputChange = (event) => {
    if (event.target.files) {
      if (event.target.files.length > 0) {
        const file = event.target.files[0];
        setText(file.name);
        setLastURL("");
      }
    }
    else {
      const url = event.target.value;
      setText(url);
      setLastURL(url);
    }
    setModalIsOpen(false); 
    if (onChange) {
      onChange(event);
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      onInputChange(event);

      // Prevent this key press from triggering the main button, and immediately opening
      // the modal again.
      event.preventDefault();
    }
  }

  const onCancelClick = () => {
    setModalIsOpen(false);
  }

  return (
    <div className="FileOrURLInput">
      <button 
        type="button"
        onClick={onMainClick}
        disabled={disabled}
        className="FileOrURLInputButton"
      >
        {text}
      </button>
      
      <Modal 
        className={modalContentClassName}
        overlayClassName={modalOverlayClassName}
        isOpen={modalIsOpen}
        ariaHideApp={false}
      >
        <div>
          <input
            type="file"
            accept={accept}
            onChange={onInputChange}
          />
          <div>
            Or URL&nbsp;
            <input
              type="url"
              onKeyDown={onKeyDown}
              defaultValue={lastUrl}
            />
          </div>
        </div>

        &nbsp;
        <button
          type="button"
          onClick={onCancelClick}
        >
          Cancel
        </button>
      </Modal>
    </div>
  );
}

FileOrURLInput.propTypes = {
    accept: PropTypes.string,
    onChange: PropTypes.func,
    disabled: PropTypes.bool,
    modalContentClassName: PropTypes.string,
    modalOverlayClassName: PropTypes.string
};

FileOrURLInput.defaultProps = {
  accept: "*",
  onChange: null,
  disabled: false,
  modalContentClassName: 'ModalContent',
  modalOverlayClassName: 'ModalOverlay'
}