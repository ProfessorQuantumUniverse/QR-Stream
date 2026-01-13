<div align="center">

  <!-- PROJECT LOGO (Placeholder or Emoji Art) -->
  <h1>📡 QR-Stream</h1>
  
  <p>
    <strong>High-Speed Optical Data Transfer Bridge</strong><br>
    <em>Transfer data across air-gapped devices using nothing but light.</em>
  </p>

  <!-- BADGES SECTION -->
  <p>
    <a href="https://github.com/ProfessorQuantumUniverse/QR-Stream/graphs/contributors">
      <img src="https://img.shields.io/github/contributors/ProfessorQuantumUniverse/QR-Stream?style=for-the-badge&color=blue" alt="Contributors">
    </a>
    <a href="https://github.com/ProfessorQuantumUniverse/QR-Stream/network/members">
      <img src="https://img.shields.io/github/forks/ProfessorQuantumUniverse/QR-Stream?style=for-the-badge&color=orange" alt="Forks">
    </a>
    <a href="https://github.com/ProfessorQuantumUniverse/QR-Stream/stargazers">
      <img src="https://img.shields.io/github/stars/ProfessorQuantumUniverse/QR-Stream?style=for-the-badge&color=gold" alt="Stars">
    </a>
    <a href="https://github.com/ProfessorQuantumUniverse/QR-Stream/issues">
      <img src="https://img.shields.io/github/issues/ProfessorQuantumUniverse/QR-Stream?style=for-the-badge&color=red" alt="Issues">
    </a>
    <br />
    <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5">
    <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
    <img src="https://img.shields.io/badge/BWIP--JS-v3.2.0-blueviolet?style=for-the-badge" alt="BWIP-JS">
    <img src="https://img.shields.io/badge/ZXing-Browser-success?style=for-the-badge" alt="ZXing">
  </p>

  <!-- LIVE DEMO BUTTONS -->
  <h3>🚀 Try it now</h3>
  <a href="https://professorquantumuniverse.github.io/QR-Stream/">
    <img src="https://img.shields.io/badge/LAUNCH-007BFF?style=flat&logo=telegram&logoColor=white&labelColor=0056b3" height="35" alt="Try Now!">
  </a>

</div>

---

## 🧐 What is QR-Stream?

**QR-Stream** is a browser-based tool that allows you to transfer text data (files, keys, messages) from one device to another **without any network connection** (WiFi, Bluetooth, NFC).

It works by turning your data into a **video stream of QR codes** (or Data Matrix codes). The receiving device uses its camera to scan this stream at high speed, stitching the data back together in real-time.

### ⚡ Perfect for Air-Gapped Security
- **Sender:** Generates an animated barcode stream.
- **Receiver:** Uses the camera to rebuild the file.
- **Security:** Ideal for moving sensitive keys or text from a secure, offline computer to a connected smartphone.

---

## ✨ Key Features

| Feature | Description |
| :--- | :--- |
| **Air-Gapped** | Zero radio transmission. 100% optical data transfer. |
| **Multi-Code** | Supports **QR Code** (Standard) and **Data Matrix** (High Density/Pixelated). |
| **Smart Chunking** | Automatically splits large text into optimized frames based on the selected code type. |
| **Robust Receiver** | Uses `@zxing/browser` for stable, industrial-grade scanning performance. |
| **Visual Feedback** | Real-time progress tracking on the receiver (`Part 5 of 20...`). |
| **No Installation** | Runs entirely in the browser using static HTML & JS. |

---

## 🛠️ How it Works (Under the Hood)

For the developers and curious minds, here is the protocol logic derived from the source code:

### 1. The Protocol
Data is split into chunks to fit into standard barcodes. Each frame contains a header:
`INDEX | TOTAL_CHUNKS | PAYLOAD`

*   **Index:** Current frame number.
*   **Total:** Total frames expected.
*   **Payload:** The actual text data.

### 2. The Engine
<details>
<summary><strong>Click to see technical stack details</strong></summary>
<br>

*   **Sender:**
    *   Uses **bwip-js** to render barcodes directly onto an HTML Canvas.
    *   Canvas rendering ensures sharp, pixel-perfect edges for easier scanning (image-smoothing disabled).
    *   **Data Matrix** mode allows for ~600 chars per frame, while **QR** does ~400.
*   **Receiver:**
    *   Uses **ZXing Browser MultiFormatReader**.
    *   Implements an async loop to scan video frames every ~160ms.
    *   Stores received chunks in a hash map (`receivedChunks[index] = data`) to handle out-of-order scanning.
    *   Only assembles the final text once `Object.keys(receivedChunks).length == totalChunks`.

</details>

---

## 🚀 Getting Started

You can run this project locally or host it on any static web server (GitHub Pages, Vercel, etc.).

### Option 1: Live Web Version
Simply navigate to the GitHub Pages link (if configured) or open the HTML files directly in your browser.

### Option 2: Local Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/ProfessorQuantumUniverse/QR-Stream.git
    cd QR-Stream
    ```

2.  **Structure:**
    Ensure your folder looks like this for the links to work:
    ```text
    /
    ├── index (6).html      (Rename to index.html)
    └── mainhtml/
        ├── sender.html
        └── receiver.html
    ```

3.  **Run:**
    *   Open `index.html` in your browser.
    *   *Note: For the Receiver to access the camera, most browsers require the site to be served via **HTTPS** or **localhost**.*

---

## 📸 Screenshots & Usage

### 📤 Sending Data
1. Open **Sender**.
2. Select **Code Type** (Data Matrix recommended for large text).
3. Paste your text into the box.
4. Click **Generate Stream**.
5. The screen will start flashing codes.

### 📥 Receiving Data
1. Open **Receiver** on a smartphone.
2. Grant **Camera Permission**.
3. Point the camera at the Sender's screen.
4. Watch the progress bar fill up.
5. Once complete, the text appears automatically!

---

## 🤝 Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1.  Fork the Project
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the Branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

---

<div align="center">
  <p>Made with ❤️ and Physics by <strong>ProfessorQuantumUniverse</strong></p>
  <p>
    <a href="https://github.com/ProfessorQuantumUniverse">
        <img src="https://img.shields.io/badge/Follow-ProfessorQuantumUniverse-black?style=social&logo=github" alt="Follow on GitHub">
    </a>
  </p>
</div>
