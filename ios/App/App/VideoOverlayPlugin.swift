import Foundation
import Capacitor
import AVFoundation
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// Plugin natif d'incrustation du chrono REPS dans une vidéo filmée avec la Caméra iOS.
// pickVideo : choisir une vidéo -> la copier dans Documents -> renvoyer chemin + durée.
// exportOverlay : incruster le chrono (frames), décalé de goOffsetSec (le GO), -> sauver dans Photos.
@objc(VideoOverlayPlugin)
public class VideoOverlayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoOverlayPlugin"
    public let jsName = "VideoOverlay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportOverlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRecording", returnType: CAPPluginReturnPromise)
    ]

    private var pickCall: CAPPluginCall?

    // ===== Enregistrement caméra natif (vidéo propre, timestamps corrects) =====
    private var captureSession: AVCaptureSession?
    private var movieOutput: AVCaptureMovieFileOutput?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var recCall: CAPPluginCall?
    private var recStartMs: Double = 0
    private var recURL: URL?
    private var audioSessionTouched = false
    private let sessionQueue = DispatchQueue(label: "reps.camera.session")

    @objc func ping(_ call: CAPPluginCall) {
        call.resolve(["value": "pong from native", "echo": call.getString("msg") ?? ""])
    }

    // Démarre la caméra + l'enregistrement dans un fichier propre, et affiche un petit
    // aperçu de cadrage. Renvoie l'heure absolue de départ (pour caler le chrono ensuite).
    @objc func startRecording(_ call: CAPPluginCall) {
        let front = (call.getString("camera") ?? "back") == "front"
        let withAudio = call.getBool("withAudio") ?? false
        // Après l'accord caméra, on demande le micro seulement si le son ambiant est voulu.
        let proceed = {
            if withAudio {
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    self.setupAndStart(call, front: front, withAudio: withAudio)
                }
            } else {
                self.setupAndStart(call, front: front, withAudio: false)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            proceed()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { proceed() }
                else { call.reject("Caméra refusée", "PERM_DENIED") }
            }
        default:
            call.reject("Caméra refusée", "PERM_DENIED")
        }
    }

    private func setupAndStart(_ call: CAPPluginCall, front: Bool, withAudio: Bool) {
        sessionQueue.async {
            // Son ambiant : on passe en playAndRecord MAIS avec mixWithOthers, pour laisser
            // Spotify / la musique REPS continuer à jouer pendant l'enregistrement.
            if withAudio {
                let s = AVAudioSession.sharedInstance()
                // Pas de .defaultToSpeaker (ça forçait la sortie sur le HP du tél) ni de
                // .allowBluetooth (HFP mono qui dégrade et re-route). On garde A2DP : la
                // musique reste sur l'enceinte, le micro du tél capte l'ambiance.
                try? s.setCategory(.playAndRecord, mode: .videoRecording,
                                   options: [.mixWithOthers, .allowBluetoothA2DP])
                try? s.setActive(true)
                self.audioSessionTouched = true
            }
            let session = AVCaptureSession()
            // IMPORTANT : ne pas laisser la caméra reconfigurer la session audio (voix + Ma musique).
            session.automaticallyConfiguresApplicationAudioSession = false
            session.beginConfiguration()
            if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
            let pos: AVCaptureDevice.Position = front ? .front : .back
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: pos)
                    ?? AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                DispatchQueue.main.async { call.reject("Caméra indisponible", "CAM_KO") }; return
            }
            session.addInput(input)
            // Micro (son ambiant) : optionnel, on continue en muet s'il n'est pas dispo/refusé.
            if withAudio, let mic = AVCaptureDevice.default(for: .audio),
               let micIn = try? AVCaptureDeviceInput(device: mic), session.canAddInput(micIn) {
                session.addInput(micIn)
            }
            let output = AVCaptureMovieFileOutput()
            guard session.canAddOutput(output) else {
                DispatchQueue.main.async { call.reject("Sortie vidéo KO", "OUT_KO") }; return
            }
            session.addOutput(output)
            if let conn = output.connection(with: .video), conn.isVideoOrientationSupported {
                conn.videoOrientation = .portrait
            }
            session.commitConfiguration()
            session.startRunning()
            self.captureSession = session
            self.movieOutput = output

            DispatchQueue.main.async {
                // Aperçu de cadrage : vignette en haut à droite, au-dessus de la WebView.
                if let host = self.bridge?.viewController?.view {
                    let pv = AVCaptureVideoPreviewLayer(session: session)
                    pv.videoGravity = .resizeAspectFill
                    let w = host.bounds.width * 0.34
                    let h = w * 16.0 / 9.0
                    pv.frame = CGRect(x: host.bounds.width - w - 12,
                                      y: host.safeAreaInsets.top + 12, width: w, height: h)
                    pv.cornerRadius = 12
                    pv.masksToBounds = true
                    pv.borderColor = UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1).cgColor
                    pv.borderWidth = 2
                    if let c = pv.connection, c.isVideoOrientationSupported { c.videoOrientation = .portrait }
                    host.layer.addSublayer(pv)
                    self.previewLayer = pv
                }
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let url = docs.appendingPathComponent("reps-cam-\(Int(Date().timeIntervalSince1970)).mov")
                try? FileManager.default.removeItem(at: url)
                self.recURL = url
                self.recStartMs = Date().timeIntervalSince1970 * 1000.0
                output.startRecording(to: url, recordingDelegate: self)
                call.resolve(["startWallClockMs": self.recStartMs])
            }
        }
    }

    // Stoppe l'enregistrement. Le delegate renvoie chemin + durée + heure de départ.
    @objc func stopRecording(_ call: CAPPluginCall) {
        guard let output = self.movieOutput, output.isRecording else {
            call.reject("Pas d'enregistrement en cours", "NOT_RECORDING"); return
        }
        self.recCall = call
        DispatchQueue.main.async { output.stopRecording() }
    }

    // Annule : stoppe, jette le fichier, retire l'aperçu.
    @objc func cancelRecording(_ call: CAPPluginCall) {
        self.recCall = nil
        let out = self.movieOutput
        let url = self.recURL
        DispatchQueue.main.async {
            if out?.isRecording == true { out?.stopRecording() }
            self.teardownCamera()
            if let u = url { try? FileManager.default.removeItem(at: u) }
            call.resolve(["cancelled": true])
        }
    }

    private func teardownCamera() {
        self.previewLayer?.removeFromSuperlayer()
        self.previewLayer = nil
        let s = self.captureSession
        self.captureSession = nil
        self.movieOutput = nil
        let restoreAudio = self.audioSessionTouched
        self.audioSessionTouched = false
        sessionQueue.async {
            s?.stopRunning()
            // Si on avait ouvert le micro, on relâche la session pour rendre la main
            // aux autres apps (Spotify) et laisser REPS reprendre son audio normal.
            if restoreAudio {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    @objc func pickVideo(_ call: CAPPluginCall) {
        self.pickCall = call
        DispatchQueue.main.async {
            var config = PHPickerConfiguration()
            config.filter = .videos
            config.selectionLimit = 1
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    @objc func exportOverlay(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("path manquant"); return }
        let frames = call.getArray("frames") as? [JSObject] ?? []
        let srcURL = URL(fileURLWithPath: path)
        let asset = AVAsset(url: srcURL)
        let dur = CMTimeGetSeconds(asset.duration)

        // CALAGE AUTOMATIQUE : on compare l'heure du GO de REPS (goWallClockMs) à l'heure
        // d'enregistrement gravée dans la vidéo par la caméra. Décalage = quand, dans la
        // vidéo, le WOD a réellement démarré. L'athlète ne place rien -> pas de triche.
        var offset = call.getDouble("goOffsetSec") ?? 0
        var autoUsed = false
        if let goMs = call.getDouble("goWallClockMs"), goMs > 0, let vidDate = self.videoCreationDate(asset) {
            let auto = (goMs / 1000.0) - vidDate.timeIntervalSince1970
            offset = max(0, min(auto, max(0, dur - 0.5)))
            autoUsed = true
        }
        self.buildAndExport(srcURL, frames: frames, goOffset: offset, autoUsed: autoUsed, call: call)
    }

    // Heure d'enregistrement gravée dans le fichier vidéo. On cherche dans TOUTES les
    // collections de métadonnées (common + chaque format), pas seulement asset.metadata.
    private func videoCreationDate(_ asset: AVAsset) -> Date? {
        var items = asset.commonMetadata
        for fmt in asset.availableMetadataFormats {
            items += asset.metadata(forFormat: fmt)
        }
        for item in items {
            let keyStr = (item.key as? String) ?? ""
            let isCreation = item.commonKey == .commonKeyCreationDate
                || item.identifier == .quickTimeMetadataCreationDate
                || item.identifier == .quickTimeUserDataCreationDate
                || keyStr == "com.apple.quicktime.creationdate"
                || keyStr == "©day"
                || keyStr.lowercased() == "creationdate"
                || keyStr.lowercased() == "creation_time"
            if isCreation {
                if let d = item.dateValue { return d }
                if let s = item.stringValue, let d = self.parseDate(s) { return d }
            }
        }
        return nil
    }

    private func parseDate(_ s: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        for fmt in ["yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'", "yyyy-MM-dd'T'HH:mm:ssZZZZZ",
                    "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd HH:mm:ss Z"] {
            df.dateFormat = fmt
            if let d = df.date(from: s) { return d }
        }
        return nil
    }

    private func rejectPick(_ msg: String) {
        DispatchQueue.main.async { self.pickCall?.reject(msg); self.pickCall = nil }
    }
    private func resolvePick(_ data: [String: Any]) {
        DispatchQueue.main.async { self.pickCall?.resolve(data); self.pickCall = nil }
    }

    private func buildAndExport(_ srcURL: URL, frames: [JSObject], goOffset: Double, autoUsed: Bool, call: CAPPluginCall) {
        let asset = AVAsset(url: srcURL)
        guard let videoTrack = asset.tracks(withMediaType: .video).first else { call.reject("Pas de piste vidéo"); return }

        let comp = AVMutableComposition()
        guard let compVideo = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            call.reject("addMutableTrack KO"); return
        }
        let range = CMTimeRange(start: .zero, duration: asset.duration)
        do {
            try compVideo.insertTimeRange(range, of: videoTrack, at: .zero)
            if let a = asset.tracks(withMediaType: .audio).first,
               let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try ca.insertTimeRange(range, of: a, at: .zero)
            }
        } catch { call.reject("insertTimeRange KO: \(error.localizedDescription)"); return }

        let natural = videoTrack.naturalSize
        let t = videoTrack.preferredTransform
        let isPortrait = abs(t.b) > 0.5 && abs(t.c) > 0.5
        let renderSize = isPortrait ? CGSize(width: natural.height, height: natural.width) : natural

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = range
        let li = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        li.setTransform(t, at: .zero)
        instruction.layerInstructions = [li]

        let vc = AVMutableVideoComposition()
        vc.renderSize = renderSize
        vc.frameDuration = CMTime(value: 1, timescale: 30)
        vc.instructions = [instruction]

        let parentLayer = CALayer()
        let videoLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: renderSize)
        videoLayer.frame = CGRect(origin: .zero, size: renderSize)
        parentLayer.addSublayer(videoLayer)

        let pad = renderSize.width * 0.04
        let videoDur = max(1.0, CMTimeGetSeconds(asset.duration))
        let blockW = renderSize.width * 0.52
        let timeH = renderSize.height * 0.075
        let topH = renderSize.height * 0.028
        let blockH = timeH + topH + renderSize.height * 0.022

        for (i, f) in frames.enumerated() {
            let start = goOffset + Double(i)
            if start >= videoDur { break }
            let s = start / videoDur
            let e = min(1.0, (start + 1.0) / videoDur)
            let topS = f["top"] as? String ?? ""
            let timeS = f["time"] as? String ?? ""
            let alert = (f["alert"] as? Bool) ?? false

            let container = CALayer()
            container.frame = CGRect(x: pad, y: pad, width: blockW, height: blockH)
            container.backgroundColor = UIColor(white: 0, alpha: 0.55).cgColor
            container.cornerRadius = renderSize.width * 0.012

            let topL = CATextLayer()
            topL.string = topS
            topL.fontSize = renderSize.height * 0.02
            topL.foregroundColor = UIColor(white: 1, alpha: 0.9).cgColor
            topL.alignmentMode = .left
            topL.contentsScale = UIScreen.main.scale
            topL.frame = CGRect(x: renderSize.width * 0.016, y: blockH - topH - renderSize.height * 0.008,
                                width: blockW - renderSize.width * 0.03, height: topH)
            container.addSublayer(topL)

            let timeL = CATextLayer()
            timeL.string = timeS
            timeL.font = CTFontCreateWithName("Menlo-Bold" as CFString, renderSize.height * 0.058, nil)
            timeL.fontSize = renderSize.height * 0.058
            timeL.foregroundColor = (alert ? UIColor.systemRed : UIColor.white).cgColor
            timeL.alignmentMode = .left
            timeL.contentsScale = UIScreen.main.scale
            timeL.frame = CGRect(x: renderSize.width * 0.016, y: renderSize.height * 0.008,
                                 width: blockW - renderSize.width * 0.03, height: timeH)
            container.addSublayer(timeL)

            let anim = CAKeyframeAnimation(keyPath: "opacity")
            anim.calculationMode = .discrete
            if s <= 0 { anim.keyTimes = [0.0, NSNumber(value: e)]; anim.values = [1, 0] }
            else { anim.keyTimes = [0.0, NSNumber(value: s), NSNumber(value: e)]; anim.values = [0, 1, 0] }
            anim.duration = videoDur
            anim.beginTime = AVCoreAnimationBeginTimeAtZero
            anim.isRemovedOnCompletion = false
            anim.fillMode = .both
            container.opacity = 0
            container.add(anim, forKey: "vis")
            parentLayer.addSublayer(container)
        }

        let brand = CATextLayer()
        brand.string = "REPS"
        brand.fontSize = renderSize.height * 0.03
        brand.foregroundColor = UIColor(white: 1, alpha: 0.85).cgColor
        brand.alignmentMode = .right
        brand.contentsScale = UIScreen.main.scale
        let bw = renderSize.width * 0.3
        brand.frame = CGRect(x: renderSize.width - bw - pad, y: pad, width: bw, height: renderSize.height * 0.04)
        parentLayer.addSublayer(brand)

        vc.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parentLayer)

        guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else {
            call.reject("Export init KO"); return
        }
        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("reps-export-\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: outURL)
        export.outputURL = outURL
        export.outputFileType = .mp4
        export.videoComposition = vc
        export.shouldOptimizeForNetworkUse = true
        export.exportAsynchronously {
            if export.status == .completed {
                self.saveToPhotos(outURL, extra: ["goOffsetSec": goOffset, "auto": autoUsed], call: call)
            } else {
                DispatchQueue.main.async { call.reject("Export KO: \(export.error?.localizedDescription ?? "inconnu")") }
            }
        }
    }

    private func saveToPhotos(_ url: URL, extra: [String: Any], call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { call.reject("Accès Photos refusé") }; return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }) { ok, err in
                DispatchQueue.main.async {
                    if ok {
                        var res: [String: Any] = ["success": true, "path": url.path]
                        res.merge(extra) { a, _ in a }
                        call.resolve(res)
                    } else {
                        call.reject("Sauvegarde Photos KO: \(err?.localizedDescription ?? "inconnu")")
                    }
                }
            }
        }
    }
}

extension VideoOverlayPlugin: AVCaptureFileOutputRecordingDelegate {
    public func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                           from connections: [AVCaptureConnection], error: Error?) {
        let dur = CMTimeGetSeconds(AVAsset(url: outputFileURL).duration)
        let call = self.recCall
        self.recCall = nil
        self.teardownCamera()
        DispatchQueue.main.async {
            guard let call = call else { return } // annulation : rien à renvoyer
            // AVFoundation renvoie parfois une "erreur" alors que le fichier est exploitable.
            if let e = error, (!FileManager.default.fileExists(atPath: outputFileURL.path) || dur < 0.3) {
                call.reject("Enregistrement KO: \(e.localizedDescription)"); return
            }
            call.resolve(["path": outputFileURL.path,
                          "durationSec": dur,
                          "startWallClockMs": self.recStartMs])
        }
    }
}

extension VideoOverlayPlugin: PHPickerViewControllerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let result = results.first else { self.rejectPick("Aucune vidéo choisie"); return }
        let provider = result.itemProvider
        let typeId = UTType.movie.identifier
        guard provider.hasItemConformingToTypeIdentifier(typeId) else { self.rejectPick("Pas une vidéo"); return }
        provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, err in
            guard let url = url else { self.rejectPick("Chargement KO: \(err?.localizedDescription ?? "inconnu")"); return }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let dst = docs.appendingPathComponent("reps-src-\(Int(Date().timeIntervalSince1970)).mov")
            try? FileManager.default.removeItem(at: dst)
            do {
                try FileManager.default.copyItem(at: url, to: dst)
                let dur = CMTimeGetSeconds(AVAsset(url: dst).duration)
                self.resolvePick(["path": dst.path, "duration": dur])
            } catch {
                self.rejectPick("Copie KO: \(error.localizedDescription)")
            }
        }
    }
}
