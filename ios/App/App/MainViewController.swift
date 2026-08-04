import UIKit
import Capacitor

// ViewController custom qui remplace le CAPBridgeViewController par défaut,
// juste pour enregistrer notre plugin natif au chargement de Capacitor.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VideoOverlayPlugin())
    }
}
