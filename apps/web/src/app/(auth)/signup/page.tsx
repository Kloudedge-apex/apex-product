import { SignUp } from "@clerk/nextjs";

export default function SignupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "bg-apex-card border border-apex-border shadow-2xl",
          },
        }}
        routing="path"
        path="/signup"
        signInUrl="/login"
        forceRedirectUrl="/onboarding"
      />
    </div>
  );
}
