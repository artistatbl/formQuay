import Navbar from "@/components/global/landing/navbar";
import { Container } from "@/components/global/container";
import Footer from "@/components/global/landing/footer";
import Faq from "@/components/global/landing/faq";
import Pricing from "@/components/global/landing/pricing";
import BottomCTA from "@/components/global/landing/bottomcta";
import BeforeAfter from "@/components/global/landing/before-after";
import TrustedCompanies from "@/components/global/landing/trustedcompanies";
import LogoClouds from "@/components/global/landing/logo.clouds";
import { WobbleCardDemo } from "@/components/global/landing/bento-grid";

export default function LandingPage() {
  return (
    <Container>
      <Navbar />
      <LogoClouds />
      <TrustedCompanies />
      <BeforeAfter />
      <WobbleCardDemo />
      <Pricing />
      <Faq />
      <BottomCTA />
      <Footer />
    </Container>
  );
}