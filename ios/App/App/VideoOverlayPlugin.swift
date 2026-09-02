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
        CAPPluginMethod(name: "cancelRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAudioMixing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternalApp", returnType: CAPPluginReturnPromise)
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

    // Bascule la session audio entre « REPS possede le son » et « REPS se melange aux
    // autres apps ». Ajoute le 31/08/2026 pour le bug du podcast coupe (cf. AppDelegate).
    //
    // Pose ici, et pas dans un nouveau plugin, pour une raison simple : ce plugin est
    // deja enregistre et deja resolu par _videoOverlayPlugin() cote JS. Un plugin de
    // plus, c'est un enregistrement de plus a rater.
    // Ouvre une autre app par son schema d'URL (spotify://, music://...).
    // Ajoute le 31/08/2026 : depuis une WKWebView, un simple location.href sur un
    // schema inconnu est avale sans rien faire. Il faut passer par le natif.
    @objc func openExternalApp(_ call: CAPPluginCall) {
        guard let brut = call.getString("url"), let url = URL(string: brut) else {
            call.reject("url manquante ou invalide"); return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.canOpenURL(url) else {
                // App absente du telephone. On ne rejette pas : le JS doit pouvoir
                // afficher un message calme plutot qu'une erreur.
                call.resolve(["opened": false, "installed": false]); return
            }
            UIApplication.shared.open(url, options: [:]) { ok in
                call.resolve(["opened": ok, "installed": true])
            }
        }
    }

    @objc func setAudioMixing(_ call: CAPPluginCall) {
        let mixer = call.getBool("mix") ?? false
        DispatchQueue.main.async {
            AppDelegate.activerSessionAudio(mixer: mixer)
            call.resolve(["mix": mixer])
        }
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
            if let conn = output.connection(with: .video) {
                if conn.isVideoOrientationSupported { conn.videoOrientation = .portrait }
                // MIROIR — camera avant uniquement (25/08/2026).
                // On ne se fie PAS au reglage automatique : il ne donne pas la meme valeur
                // sur une connexion d'apercu et sur une connexion de sortie, et ce n'est
                // pas contractuel. On coupe l'automatisme AVANT d'ecrire isVideoMirrored :
                // tant qu'il est actif la propriete est en lecture seule et l'affectation
                // leve une exception.
                // Le miroir est ecrit dans le fichier (transform de la piste). L'export
                // le conserve : buildAndExport() applique videoTrack.preferredTransform.
                // Le chrono, lui, est incruste APRES : il n'est jamais inverse.
                if conn.isVideoMirroringSupported {
                    conn.automaticallyAdjustsVideoMirroring = false
                    conn.isVideoMirrored = front
                }
            }
            session.commitConfiguration()
            session.startRunning()
            self.captureSession = session
            self.movieOutput = output

            DispatchQueue.main.async {
                // Apercu de cadrage : ECRAN PARTAGE.
                //
                // Les versions precedentes posaient une vignette flottante PAR-DESSUS
                // l'interface : quoi qu'on fasse elle recouvrait quelque chose (header,
                // carte chrono, ou boutons). Ici l'apercu prend franchement le HAUT de
                // l'ecran, sur toute la largeur, et le web descend toute son interface
                // en dessous (classe `body.filming`, variable CSS --cam-h).
                //
                // ⚠ camFraction DOIT rester egal a --cam-h dans index.html (40dvh).
                // Si l'un change, changer l'autre, sinon il y a un trou ou un recouvrement.
                // Hauteur pilotee par le WEB depuis le 17/08/2026 : --cam-h est la seule
                // source de verite, toggleFilm() l'envoie en camHeightPx. Le repli sur
                // 0.40 ne sert que si un ancien build web appelle sans ce parametre.
                let camPxAsked = call.getDouble("camHeightPx") ?? 0
                if let host = self.bridge?.viewController?.view {
                    let pv = AVCaptureVideoPreviewLayer(session: session)
                    pv.videoGravity = .resizeAspectFill
                    let H = host.bounds.height
                    let W = host.bounds.width
                    let camH = camPxAsked > 40 ? CGFloat(camPxAsked) : H * 0.40
                    // Plein bord depuis le haut de l'ecran (on passe sous la barre d'etat).
                    pv.frame = CGRect(x: 0, y: 0, width: W, height: camH)
                    // Coins arrondis en bas seulement : l'apercu se lit comme un bandeau.
                    pv.cornerRadius = 18
                    pv.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
                    pv.masksToBounds = true
                    if let c = pv.connection {
                        if c.isVideoOrientationSupported { c.videoOrientation = .portrait }
                        // L'apercu doit montrer EXACTEMENT ce qui part dans le fichier,
                        // sinon le coach cadre sur une image et en obtient une autre.
                        if c.isVideoMirroringSupported {
                            c.automaticallyAdjustsVideoMirroring = false
                            c.isVideoMirrored = front
                        }
                    }
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
                // Le filmage a bascule la session en .playAndRecord. Si on ne remet pas
                // .playback, l'app reste dans cette categorie apres le tournage et le son
                // repasse sous le controle de l'interrupteur silencieux : plus de musique
                // pour le WOD suivant si l'interrupteur est actif.
                DispatchQueue.main.async { AppDelegate.activerSessionAudio() }
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
        let timeH = renderSize.height * 0.075
        let topH = renderSize.height * 0.028
        let blockH = timeH + topH + renderSize.height * 0.022

        // Geometrie interne de la carte, calculee UNE SEULE FOIS pour toutes les frames.
        let stripeW = renderSize.width * 0.009
        let textX = stripeW + renderSize.width * 0.018
        let ctxSize = renderSize.height * 0.021
        let ctxFont = UIFont(name: "AvenirNextCondensed-DemiBold", size: ctxSize)
            ?? UIFont.systemFont(ofSize: ctxSize, weight: .semibold)
        let ctxKern = renderSize.height * 0.004

        // Largeur de la carte. Elle etait figee a 0.52 * largeur : une ligne de contexte
        // longue comme "EMOM · ROUND 1/2 · REST" etait coupee en plein mot ("... · RE"),
        // visible a l'export. On mesure donc la ligne la plus longue de TOUTE la video et
        // on dimensionne dessus : la carte reste large assez, et surtout d'une largeur
        // constante d'une frame a l'autre (sinon elle "respirerait" a chaque seconde).
        let ctxMaxW = frames.compactMap { ($0["top"] as? String)?.uppercased() }
            .map { ($0 as NSString).size(withAttributes: [.font: ctxFont, .kern: ctxKern]).width }
            .max() ?? 0
        let blockW = min(renderSize.width - pad * 2,
                         max(renderSize.width * 0.52, ctxMaxW + textX + renderSize.width * 0.045))

        // ------------------------------------------------------------------
        // MONTAGE ALLEGE (10/08/2026)
        //
        // AVANT : 4 couches CALayer + 1 animation PAR SECONDE de video. Sur un WOD
        // de 10 min cela faisait 2400 couches empilees dans un seul
        // AVVideoCompositionCoreAnimationTool, et l'export echouait en silence
        // (« MONTAGE ECHOUE » cote app). Une video d'1 min (240 couches) passait.
        //
        // MAINTENANT :
        //   1. la carte (fond, bordure, liseré) est creee UNE SEULE FOIS ;
        //   2. la ligne de contexte n'est recreee que lorsqu'elle CHANGE
        //      (en EMOM : 2 fois par round, au lieu de 60 fois par minute) ;
        //   3. seul le chrono garde une couche par seconde : lui change vraiment
        //      a chaque seconde, on ne peut pas le regrouper.
        //
        // Sur 10 min on passe d'environ 2400 couches a environ 620.
        // ------------------------------------------------------------------

        // Visibilite d'une couche sur l'intervalle [debut, fin], en secondes video.
        func visibilite(_ debut: Double, _ fin: Double) -> CAKeyframeAnimation {
            let s = max(0.0, debut / videoDur)
            let e = min(1.0, fin / videoDur)
            let anim = CAKeyframeAnimation(keyPath: "opacity")
            anim.calculationMode = .discrete
            if s <= 0 { anim.keyTimes = [0.0, NSNumber(value: e)]; anim.values = [1, 0] }
            else { anim.keyTimes = [0.0, NSNumber(value: s), NSNumber(value: e)]; anim.values = [0, 1, 0] }
            anim.duration = videoDur
            anim.beginTime = AVCoreAnimationBeginTimeAtZero
            anim.isRemovedOnCompletion = false
            anim.fillMode = .both
            return anim
        }

        // Nombre de frames qui tiennent reellement dans la duree de la video.
        var nbUtiles = 0
        for i in 0..<frames.count where goOffset + Double(i) < videoDur { nbUtiles = i + 1 }

        if nbUtiles > 0 {
            // --- 1. La carte : statique, une seule couche pour toute la video ---
            let card = CALayer()
            card.frame = CGRect(x: pad, y: pad, width: blockW, height: blockH)
            card.backgroundColor = UIColor(white: 0.02, alpha: 1.0).cgColor // opaque : les couches d'effacement doivent se fondre dedans
            card.cornerRadius = renderSize.width * 0.024
            card.masksToBounds = true
            card.borderWidth = max(1, renderSize.width * 0.0022)
            card.borderColor = Self.repsMagenta.withAlphaComponent(0.35).cgColor
            card.opacity = 0
            card.add(visibilite(goOffset, min(videoDur, goOffset + Double(nbUtiles))), forKey: "vis")

            // Liseré vertical degrade : la signature visuelle de l'app, en petit.
            let stripe = CAGradientLayer()
            stripe.frame = CGRect(x: 0, y: 0, width: stripeW, height: blockH)
            stripe.colors = [Self.repsCyan.cgColor, Self.repsMagenta.cgColor]
            stripe.startPoint = CGPoint(x: 0.5, y: 0)
            stripe.endPoint = CGPoint(x: 0.5, y: 1)
            card.addSublayer(stripe)
            parentLayer.addSublayer(card)

            // REGRESSION CORRIGEE LE 10/08/2026
            // Premiere version de cet allegement : les textes etaient des ENFANTS de
            // `card`, qui porte elle-meme une animation d'opacite. Or le beginTime
            // d'une animation enfant s'interprete dans l'espace de temps du parent :
            // AVCoreAnimationBeginTimeAtZero imbrique a fausse le decoupage discret,
            // et PLUSIEURS secondes restaient visibles en meme temps (chiffres
            // fantomes, halos accumules, verifie a l'image sur l'export du 10/08).
            // Les textes sont donc redevenus FRERES de la carte dans parentLayer,
            // comme dans le code d'origine : meme espace de temps, decoupage net.
            // Leurs coordonnees passent en absolu (decalees de l'origine de la carte).
            let ox = pad, oy = pad

            // --- 2. Ligne de contexte : une couche par PLAGE de texte identique ---
            let ctxFrame = CGRect(x: ox + textX, y: oy + blockH - topH - renderSize.height * 0.010,
                                  width: blockW - textX - renderSize.width * 0.02, height: topH)
            var i = 0
            while i < nbUtiles {
                let texte = (frames[i]["top"] as? String ?? "").uppercased()
                var j = i + 1
                while j < nbUtiles && (frames[j]["top"] as? String ?? "").uppercased() == texte { j += 1 }
                if !texte.isEmpty {
                    let topL = CATextLayer()
                    topL.truncationMode = .end   // filet de securite si la mesure est prise en defaut
                    topL.string = NSAttributedString(string: texte, attributes: [
                        .font: ctxFont,
                        .kern: ctxKern,
                        .foregroundColor: Self.repsCyan
                    ])
                    topL.alignmentMode = .left
                    topL.contentsScale = UIScreen.main.scale
                    topL.frame = ctxFrame
                    topL.opacity = 0
                    let effaceCtx = CALayer()
                    effaceCtx.frame = ctxFrame
                    effaceCtx.backgroundColor = UIColor(white: 0.02, alpha: 1.0).cgColor
                    effaceCtx.opacity = 0
                    effaceCtx.add(visibilite(goOffset + Double(i),
                                             min(videoDur, goOffset + Double(j))), forKey: "vis")
                    parentLayer.addSublayer(effaceCtx)

                    topL.add(visibilite(goOffset + Double(i),
                                        min(videoDur, goOffset + Double(j))), forKey: "vis")
                    parentLayer.addSublayer(topL)
                }
                i = j
            }

            // --- 3. Chrono : une couche par seconde. Monospace pour que les chiffres
            // ne dansent pas. Blanc, magenta REPS sur les 3 dernieres secondes
            // (le rouge pur jurait avec la palette). ---
            let timeFont = UIFont(name: "Menlo-Bold", size: renderSize.height * 0.062)
                ?? UIFont.monospacedDigitSystemFont(ofSize: renderSize.height * 0.062, weight: .bold)
            let timeFrame = CGRect(x: ox + textX, y: oy + renderSize.height * 0.010,
                                   width: blockW - textX - renderSize.width * 0.02, height: timeH)
            for k in 0..<nbUtiles {
                let timeS = frames[k]["time"] as? String ?? ""
                if timeS.isEmpty { continue }
                let alert = (frames[k]["alert"] as? Bool) ?? false
                let timeL = CATextLayer()
                timeL.string = NSAttributedString(string: timeS, attributes: [
                    .font: timeFont,
                    .kern: renderSize.height * 0.002,
                    .foregroundColor: alert ? Self.repsMagenta : UIColor.white
                ])
                timeL.alignmentMode = .left
                timeL.contentsScale = UIScreen.main.scale
                // Halo discret : garde le chrono lisible sur un fond clair (salle, plein jour).
                timeL.shadowColor = (alert ? Self.repsMagenta : Self.repsCyan).cgColor
                timeL.shadowOpacity = alert ? 0.55 : 0.35
                timeL.shadowRadius = renderSize.height * 0.006
                timeL.shadowOffset = .zero
                timeL.frame = timeFrame
                timeL.opacity = 0
                // FANTOME (corrige le 16/08/2026) : le rendu ne repeint que la zone qui
                // change, donc le chiffre de la seconde precedente restait visible dessous.
                // Une couche opaque, meme cadre et meme fenetre de visibilite, efface
                // la seconde precedente avant que le texte ne soit dessine par-dessus.
                let effaceTime = CALayer()
                effaceTime.frame = timeFrame
                effaceTime.backgroundColor = UIColor(white: 0.02, alpha: 1.0).cgColor
                effaceTime.opacity = 0
                effaceTime.add(visibilite(goOffset + Double(k),
                                          min(videoDur, goOffset + Double(k) + 0.96)), forKey: "vis")
                parentLayer.addSublayer(effaceTime)

                timeL.add(visibilite(goOffset + Double(k),
                                     min(videoDur, goOffset + Double(k) + 0.96)), forKey: "vis")
                parentLayer.addSublayer(timeL)
            }
        }

        // Logo « R·E·P·S » en degrade, comme l'en-tete de l'app : c'est la signature
        // qui doit rendre la video reconnaissable. Repli sur du texte blanc si le
        // rendu de l'image echoue, pour ne jamais exporter une video sans marque.
        if let logo = makeLogoImage(height: renderSize.height * 0.038), logo.size.height > 0 {
            let bh = renderSize.height * 0.050
            let bw = bh * (logo.size.width / logo.size.height)
            // Pastille sombre derriere le logo : sans elle, le degrade disparait sur un
            // fond clair (carrelage, mur blanc, plein jour). Meme matiere que la carte
            // du chrono, pour que l'ensemble se lise comme une seule identite.
            let padH = renderSize.height * 0.012
            let padW = renderSize.width * 0.022
            let plate = CALayer()
            plate.frame = CGRect(x: renderSize.width - bw - pad - padW,
                                 y: pad - padH * 0.5,
                                 width: bw + padW * 2, height: bh + padH)
            plate.backgroundColor = UIColor(white: 0.02, alpha: 0.5).cgColor
            plate.cornerRadius = (bh + padH) / 2
            parentLayer.addSublayer(plate)

            let bl = CALayer()
            bl.contents = logo.cgImage
            bl.contentsGravity = .resizeAspect
            bl.contentsScale = logo.scale
            bl.frame = CGRect(x: renderSize.width - bw - pad, y: pad, width: bw, height: bh)
            bl.shadowColor = UIColor.black.cgColor
            bl.shadowOpacity = 0.7
            bl.shadowRadius = renderSize.height * 0.005
            bl.shadowOffset = .zero
            parentLayer.addSublayer(bl)
        } else {
            let brand = CATextLayer()
            brand.string = "R·E·P·S"
            brand.fontSize = renderSize.height * 0.03
            brand.foregroundColor = UIColor(white: 1, alpha: 0.85).cgColor
            brand.alignmentMode = .right
            brand.contentsScale = UIScreen.main.scale
            let bw = renderSize.width * 0.3
            brand.frame = CGRect(x: renderSize.width - bw - pad, y: pad, width: bw, height: renderSize.height * 0.04)
            parentLayer.addSublayer(brand)
        }

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

    // MARK: - Identite visuelle REPS (incrustation video)

    /// Couleurs de marque, reprises telles quelles du CSS de l'app (--accent / --accent2).
    static let repsMagenta = UIColor(red: 0.902, green: 0.247, blue: 1.0, alpha: 1.0)   // #e63fff
    static let repsCyan    = UIColor(red: 0.0,   green: 0.898, blue: 1.0, alpha: 1.0)   // #00e5ff

    /// Rend le logo « R·E·P·S » en degrade magenta -> cyan, comme dans l'en-tete de l'app.
    ///
    /// On passe par une IMAGE plutot que par un CATextLayer masque par un CAGradientLayer :
    /// AVVideoCompositionCoreAnimationTool rend l'arbre de calques hors ecran, et les masques
    /// y sont capricieux. Une bitmap, elle, est toujours rendue telle quelle.
    private func makeLogoImage(height: CGFloat) -> UIImage? {
        let text = "R·E·P·S"
        let font = UIFont(name: "AvenirNextCondensed-Bold", size: height)
            ?? UIFont.systemFont(ofSize: height, weight: .heavy)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .kern: height * 0.16,          // le logo de l'app est tres espace
            .foregroundColor: UIColor.white
        ]
        let s = (text as NSString).size(withAttributes: attrs)
        let w = ceil(s.width) + 6, h = ceil(s.height) + 6
        guard w > 0, h > 0 else { return nil }
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h)).image { ctx in
            let cg = ctx.cgContext
            (text as NSString).draw(at: CGPoint(x: 3, y: 3), withAttributes: attrs)
            // On repeint le degrade UNIQUEMENT sur les pixels du texte deja traces.
            cg.setBlendMode(.sourceIn)
            let cols = [Self.repsMagenta.cgColor, Self.repsCyan.cgColor] as CFArray
            if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: cols, locations: [0, 1]) {
                cg.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: w, y: 0), options: [])
            }
        }
    }
}
