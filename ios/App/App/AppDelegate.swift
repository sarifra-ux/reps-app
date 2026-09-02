import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Categorie audio de l'app : `.playback`.
    ///
    /// Pourquoi c'est indispensable depuis le 22/08/2026 : la musique passe desormais
    /// par un GainNode Web Audio (seul moyen de faire marcher le ducking sur iPhone,
    /// Apple ignorant `el.volume` sur un <audio>). Or sur iOS la Web Audio est MUETTE
    /// quand le petit interrupteur lateral est sur silencieux, alors que l'audio HTML
    /// continue de sortir. Sans `.playback`, un coach en mode silencieux se retrouverait
    /// donc sans musique du tout : on aurait repare le ducking en cassant le son.
    ///
    /// `.playback` fait sortir le son quel que soit l'interrupteur.
    ///
    /// ===== CORRECTIF DU 31/08/2026 : DEUX REGIMES, PAS UN =====
    ///
    /// Jusqu'ici : `options: []`, sans `.mixWithOthers`, avec ce commentaire — « un
    /// chrono de WOD doit couvrir Spotify, pas se melanger avec ». C'est vrai dans une
    /// box, sur une sono. C'est faux partout ailleurs, et ca produisait un bug :
    ///
    ///   Adriana, sortie velo en zone 2, ecoute un podcast et lance un For Time. A
    ///   chaque annonce, REPS prend la session audio et COUPE le podcast. Pas de mise
    ///   en pause : une interruption dont l'autre app ne revient pas, il faut rouvrir
    ///   et relancer. A chaque annonce. (Retour du 31/08/2026.)
    ///
    /// Deux usages opposes, donc deux regimes :
    ///
    ///   mixer = false  (defaut, musique REPS) : `options: []`. REPS possede le son.
    ///                  C'est ce qu'on veut sur la sono d'une box.
    ///   mixer = true   (mode « Ma musique ») : `.mixWithOthers` + `.duckOthers`.
    ///                  Le podcast ou Spotify continue, et iOS le BAISSE tout seul
    ///                  pendant l'annonce, puis le remonte. Le ducking est fait par le
    ///                  systeme, pas par nous : c'est le seul moyen, on ne peut pas
    ///                  toucher au volume d'une autre app.
    ///
    /// Le passage en mode mixe DESACTIVE d'abord la session avec
    /// `.notifyOthersOnDeactivation` : sans ca, une app deja interrompue par REPS ne
    /// redemarre jamais, et Adriana devrait encore relancer son podcast une fois.
    ///
    /// /!\ CE CODE N'A PAS ETE COMPILE. Il doit etre construit dans Xcode puis
    ///     ESSAYE SUR IPHONE, podcast en cours, dans les deux modes.
    static func activerSessionAudio(mixer: Bool = false) {
        let s = AVAudioSession.sharedInstance()
        do {
            if mixer {
                try? s.setActive(false, options: .notifyOthersOnDeactivation)
                try s.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
            } else {
                try s.setCategory(.playback, mode: .default, options: [])
            }
            try s.setActive(true)
        } catch {
            NSLog("REPS: AVAudioSession .playback KO — \(error.localizedDescription)")
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppDelegate.activerSessionAudio()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
