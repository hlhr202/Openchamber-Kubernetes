# OpenChamber Kubernetes Explorer

[English](../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Nederlands](README.nl.md) | Polski | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

Rozszerzenie Kubernetes dla OpenChamber. Przeglądaj klastry, diagnozuj problemy z obciążeniami i wykonuj typowe operacje Kubernetes bez opuszczania obszaru roboczego projektu.

## Instalacja

Po opublikowaniu gotowych plików rozszerzenia w domyślnej gałęzi repozytorium:

1. W OpenChamber otwórz **Ustawienia → Rozszerzenia**.
2. Wklej adres repozytorium w polu **Folder, ZIP lub URL** i kliknij **Dodaj**:

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. Sprawdź i przyznaj żądane uprawnienie do korzystania z usługi lokalnej, po czym otwórz **Kubernetes** z paska rozszerzeń.

Nie trzeba niczego kompilować lokalnie ani instalować zależności JavaScript. Dopóki repozytorium jest prywatne, OpenChamber Server musi już dysponować danymi uwierzytelniającymi Git pozwalającymi na jego odczyt przez HTTPS. Zalogowanie się do GitHuba w przeglądarce nie udostępnia tych danych serwerowi.

Dla [wersji kandydującej zweryfikowanej w Dockerze](status.md) dostępne jest także gotowe archiwum ZIP do ręcznej instalacji. Instalacja z adresu Git nie została jeszcze zweryfikowana.

## Wymagania

- **OpenChamber 2.5.1** — docelowa wersja tego rozszerzenia.
- Działający **kubeconfig** dostępny dla użytkownika systemu operacyjnego, który uruchamia OpenChamber Server, oraz dostęp sieciowy do API Kubernetes i uprawnienia do zamierzonych operacji.
- Na serwerze musi być dostępne **`kubectl`**. Operacje korzystające z Helm CLI wymagają **Helm**. Jeśli kubeconfig korzysta z zewnętrznego programu uwierzytelniającego, on również musi być dostępny na serwerze. Rozszerzenie nie instaluje tych narzędzi.

## Funkcje

- Przełączanie kontekstów i przestrzeni nazw Kubernetes oraz przeglądanie obciążeń, usług i zasobów niestandardowych w drzewie zasobów.
- Przeglądanie manifestów zasobów, logów podów i zdarzeń w przestrzeniach nazw.
- Sprawdzanie zmian w manifestach i stosowanie ich na żądanie do wybranego celu.
- Otwieranie terminala w wybranym kontenerze i konfigurowanie przekierowania portów.
- Przeglądanie repozytoriów, chartów, wydań i historii rewizji Helm.

## Co przetestował autor

Autor osobiście przetestował tylko cztery przypadki: rozwijanie list w drzewie zasobów, przeglądanie szczegółów zasobów, korzystanie z terminala w kontenerze i przekierowywanie portów. Jeśli masz pytania lub napotkasz problemy przy innych operacjach, [utwórz zgłoszenie na GitHubie](https://github.com/hlhr202/Openchamber-Kubernetes/issues).

## Prywatność

- Rozszerzenie nie wysyła twórcom danych telemetrycznych ani analitycznych. Używa kubeconfig dostępnego na serwerze, aby połączyć się ze skonfigurowanym API Kubernetes z Twoimi dotychczasowymi uprawnieniami.
- Pobrane dane zasobów, logi, wyniki wyświetlane w terminalu i niezapisane szkice pozostają w pamięci i nie są zapisywane na dysku. Rozszerzenie zapisuje niewrażliwe preferencje, takie jak wybór źródeł kubeconfig, ale nie treść plików kubeconfig. Zapis i eksport na żądanie są osobnymi operacjami.
- Wartości obiektów Secret są wyświetlane wyłącznie na żądanie, o ile zezwalają na to uprawnienia w Kubernetes. Dane klastra nie trafiają automatycznie do czatu ani do dostawcy modelu.

To oświadczenie dotyczy rozszerzenia, a nie OpenChamber, Kubernetes ani używanych z nim zewnętrznych narzędzi i usług.

## Licencja

[MIT](../LICENSE). Dołączone zależności zachowują swoje licencje. Zobacz `THIRD_PARTY_NOTICES.txt` w gotowym pakiecie.

[Dokumentacja projektu](README.md) · [Zakres produktu](product.md) · [Informacje dla programistów](development.md)
